import {
    DescribeContainerInstancesCommand,
    DescribeTasksCommand,
    ECSClient,
    ListTasksCommand
} from '@aws-sdk/client-ecs';
import {DescribeInstancesCommand, EC2Client} from "@aws-sdk/client-ec2";

import { writeFile } from 'fs';

const cluster = process.env.CLUSTER_NAME;

const interval = process.env.INTERVAL || 2 * 60;

const clientConfig = {
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_ACCESS_KEY_SECRET
    }
}

const path = process.env.RESULT_FILES_DIR_PATH || './results';


const ecs = new ECSClient(clientConfig);

const ec2 = new EC2Client(clientConfig);

async function collectInstances() {
    const result = await ecs.send(new ListTasksCommand({
        cluster,
        desiredStatus: 'RUNNING'
    }))

    const describedTasks = await ecs.send(new DescribeTasksCommand({
        cluster,
        tasks: result.taskArns,
        include: ["TAGS"]
    }))

    const containers = describedTasks.tasks
        .filter(task => {
            return task.tags && task.tags.some(({key, value}) => key === 'PROM_METRICS_AVAILABLE' && value === 'True');
        })
        .map((task) => ({containerInstanceArn: task.containerInstanceArn, containers: task.containers}))
        .reduce((acc, {containerInstanceArn, containers}) => {
            const res = containers.map((container) => {
                container.containerInstanceArn = containerInstanceArn;
                return container;
            })
            return acc.concat(res);
        }, []);

    const containerInstances = await ecs.send(new DescribeContainerInstancesCommand({
        cluster,
        containerInstances: containers.map(({ containerInstanceArn }) => containerInstanceArn)
    }))

    const containerInstanceEc2 = containerInstances.containerInstances.reduce((acc, value) => {
        acc[value.containerInstanceArn] = value.ec2InstanceId;
        return acc;
    }, {});



    const describedInstances = await ec2.send(new DescribeInstancesCommand({
        InstanceIds: Object.values(containerInstanceEc2),
    }));

    const instanceIps = describedInstances.Reservations.map(reservation => reservation.Instances.map(instance => ({
        instanceId: instance.InstanceId,
        privateAddr: instance.PrivateIpAddress,
        publicAddr: instance.PublicIpAddress
    }))).flat().reduce((acc, val)=> {
        acc[val.instanceId] = val;
        return acc;
    }, {});


    const finalContainers = containers.map((container) => {
        container.IPs = instanceIps[containerInstanceEc2[container.containerInstanceArn]]
        return container;
    })

    return finalContainers.reduce((acc, container) => {

        if (!acc[container.name]) {
            acc[container.name] = {
                labels: {
                    job: container.name,
                },
                targets: []
            }
        }

        acc[container.name].targets.push(`${container.IPs.privateAddr}:${container.networkBindings[0].hostPort}`)

        return acc;
    }, {});
}


setInterval(async () => {
    const finalResults = await collectInstances();

    console.log(finalResults);

    Object.entries(finalResults).forEach(([key, value]) => {
        writeFile(`${path}/${key}.json`, JSON.stringify([value]), {
            encoding: 'utf-8'
        }, (e) => {
            if (e) {
                console.error(e);
            }
        });
    })
}, interval * 1000);


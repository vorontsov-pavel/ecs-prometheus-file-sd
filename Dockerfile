FROM node:18.12-alpine
WORKDIR /app

COPY ./ ./
RUN npm install
CMD npm start
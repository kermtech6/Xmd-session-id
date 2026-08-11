FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=3999
EXPOSE 3999
CMD ["npm", "start"]

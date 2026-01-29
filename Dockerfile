# Build stage
FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (including prisma)
RUN npm ci

# Copy app files
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Expose port
EXPOSE 3000

# Start app
CMD ["sh", "-c", "npx prisma migrate deploy && npm start"]


# Build stage
FROM node:18-alpine AS builder

WORKDIR /app

# Copy all config and entry files first
COPY package.json package-lock.json* postcss.config.js tailwind.config.js tsconfig.json tsconfig.node.json vite.config.ts index.html ./

# Copy source and public directories  
COPY src ./src
COPY public ./public

# Install dependencies
RUN npm install

# Build the application  
RUN npm run build

# Production stage
FROM nginx:alpine

# Copy nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy built app from builder
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]

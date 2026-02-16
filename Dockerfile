
FROM node:22-alpine
 
# Set working directory
WORKDIR /usr/src
 
# Copy package files first for caching
COPY package.json package-lock.json ./
 
 
# Install Node.js dependencies
RUN npm install --legacy-peer-deps
 
# Copy application source code
COPY . .
 
 
# Expose app port
EXPOSE 3000
 
# Start the app
CMD ["npm", "run", "serve"]
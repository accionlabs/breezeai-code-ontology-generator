FROM node:22-alpine

WORKDIR /usr/src/app

# Install full native build toolchain for node-gyp
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    build-base \
    libc6-compat

# Tell npm explicitly where python is
ENV PYTHON=/usr/bin/python3

# Copy dependency files first
COPY package.json package-lock.json ./

# Install dependencies
RUN npm install --legacy-peer-deps

# Copy rest of app
COPY . .

EXPOSE 3000

CMD ["npm", "run", "serve"]

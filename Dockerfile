FROM node:22-alpine

WORKDIR /usr/src/app

# Install build tools
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    build-base \
    libc6-compat

ENV PYTHON=/usr/bin/python3

# Copy entire project first (required because of postinstall script)
COPY . .

# Then install dependencies
RUN npm install --legacy-peer-deps

EXPOSE 3000

CMD ["npm", "run", "serve"]

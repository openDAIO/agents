FROM node:20-bookworm-slim

ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --include=dev --no-audit --no-fund

COPY contracts/package.json contracts/package-lock.json ./contracts/
RUN cd contracts && npm ci --include=dev --no-audit --no-fund

COPY contracts ./contracts
RUN cd contracts && npx hardhat compile

COPY src ./src
COPY scripts ./scripts
COPY docker ./docker
COPY README.md REVIEWER_AGENT_INTERFACES.md ./

RUN chmod +x /app/docker/*.sh \
  && mkdir -p /app/data /app/state /app/deployments /app/generated-deployments

EXPOSE 18002

CMD ["npm", "run", "content-service"]

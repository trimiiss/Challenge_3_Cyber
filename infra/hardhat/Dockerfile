FROM node:22-bookworm-slim
WORKDIR /chain
ENV HARDHAT_DISABLE_TELEMETRY_PROMPT=true
COPY package.json hardhat.config.cjs ./
RUN npm install --no-audit --no-fund
EXPOSE 8545
CMD ["npx", "hardhat", "--config", "hardhat.config.cjs", "node", "--hostname", "0.0.0.0", "--port", "8545"]

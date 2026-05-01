# Docker Compose Operation

This stack runs one content API, one MarkItDown conversion API, and five reviewer agents. It is meant for a Sepolia deployment, but the same shape works with any RPC URL and matching deployment snapshot.

## 1. Prepare the host

On a fresh EC2 instance, install Docker Engine and the Docker Compose plugin, then clone with submodules:

```sh
git clone --recursive <repo-url> daio-agents
cd daio-agents
cp .env.example .env
mkdir -p .deployments .data .state
chmod 700 .data .state
chmod 600 .env
```

If you cloned without submodules:

```sh
git submodule update --init --recursive
```

## 2. Fill `.env`

Required values:

```sh
RPC_URL=https://sepolia.infura.io/v3/...
AGENT_STATE_KEY=0x...
AGENT_1_PRIVATE_KEY=0x...
AGENT_2_PRIVATE_KEY=0x...
AGENT_3_PRIVATE_KEY=0x...
AGENT_4_PRIVATE_KEY=0x...
AGENT_5_PRIVATE_KEY=0x...
```

These keys must be funded on Sepolia and allowed by the deployed contracts. If you set `AGENT_AUTO_REGISTER=true`, the agent entrypoint will attempt registry registration with `AGENT_N_ID` and `AGENT_N_ENS_NAME`; funding, staking, and any contract-side permissions still need to be satisfied for the deployment you point at.

Generate a state key:

```sh
printf '0x%s\n' "$(openssl rand -hex 32)"
```

The deployment snapshot can be provided in either form:

```sh
cp /path/to/sepolia.json .deployments/sepolia.json
DAIO_DEPLOYMENT_FILE=sepolia.json
```

or as an environment value:

```sh
DAIO_DEPLOYMENT_JSON_B64=<base64 encoded deployment json>
```

On Linux, encode with:

```sh
base64 -w0 .deployments/sepolia.json
```

On macOS:

```sh
base64 < .deployments/sepolia.json | tr -d '\n'
```

## 3. Start

```sh
docker compose up -d --build
docker compose ps
```

Health checks:

```sh
curl http://127.0.0.1:18002/health
curl http://127.0.0.1:18003/health
```

Logs:

```sh
docker compose logs -f content-service agent-1
docker compose logs -f agent-1 agent-2 agent-3 agent-4 agent-5
```

## 4. Document conversion

The MarkItDown service converts uploaded files into Markdown. Submit the returned Markdown to the content API request document endpoint.

```sh
curl -sS -F file=@paper.pdf http://127.0.0.1:18003/convert
```

For raw uploads:

```sh
curl -sS \
  -H 'X-Filename: paper.pdf' \
  --data-binary @paper.pdf \
  http://127.0.0.1:18003/convert
```

WebP uploads are accepted; the server pre-converts `.webp` files to PNG before handing them to MarkItDown.

## 5. Networking and security

By default, the APIs bind to `127.0.0.1` on the host. For Tailscale-only access, set:

```sh
CONTENT_SERVICE_BIND=<tailscale-ip>
MARKITDOWN_BIND=<tailscale-ip>
```

Avoid binding to `0.0.0.0` unless the EC2 security group, host firewall, and any API authentication layer are already configured. Private keys live in `.env`, so keep that file out of Git and restrict filesystem access.

## 6. Operational notes

The content service persists SQLite data under `./.data/content.sqlite`; agent local state is under `./.state/agent-*`. The contracts are compiled inside the app image so ABI artifacts match the checked-out contracts submodule.

Agents run with `DAIO_AUTO_START_REQUESTS=true` and will actively try to join eligible requests whenever the contract allows it. Tune `DAIO_START_REQUESTS_MAX_PER_TICK`, `DAIO_START_REQUESTS_MIN_INTERVAL_MS`, and the contract-side active request limit together when increasing throughput.

# wrangler-profiles

Manage multiple Cloudflare accounts for Wrangler deployments. Switch between accounts with a single command.

## Installation

```bash
npm install -g wrangler-profiles
```

## Quick Start

```bash
# Add a profile using OAuth (browser login) - recommended
wrangler-profiles add personal --oauth

# Add a profile using API token
wrangler-profiles add work --token

# Switch between profiles
wrangler-profiles use personal

# Run wrangler commands with the active profile
wrangler-profiles run deploy
wrangler-profiles run tail --env production
```

## Commands

| Command | Description |
|---------|-------------|
| `list` | List all profiles |
| `add <name> --oauth` | Add profile using OAuth browser login |
| `add <name> --token` | Add profile using API token |
| `use <name>` | Switch to a profile |
| `current` | Show current profile |
| `login <name>` | Re-authenticate an OAuth profile |
| `deploy [env]` | Deploy with current profile |
| `run <args...>` | Run any wrangler command with current profile |
| `remove <name>` | Remove a profile |
| `env` | Output path to env file (API token profiles only) |

## Authentication Methods

### OAuth (Recommended)

Opens your browser to authenticate with Cloudflare. Tokens are automatically refreshed.

```bash
wrangler-profiles add myaccount --oauth
```

### API Token

Manually enter an API token from the [Cloudflare dashboard](https://dash.cloudflare.com/profile/api-tokens).

```bash
wrangler-profiles add myaccount --token
```

## How It Works

- **OAuth profiles**: Manages `~/.wrangler/config/default.toml` (or `~/Library/Preferences/.wrangler/config/default.toml` on macOS)
- **API token profiles**: Sets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` environment variables

Profile data is stored in `~/.wrangler-profiles/`.

## Examples

```bash
# List all profiles with their auth type
$ wrangler-profiles list
Available Wrangler profiles:

  → personal [oauth] (active)
    work [token]

# Show current profile details
$ wrangler-profiles current
Current profile: personal
Type: OAuth
Account ID: abc123...

# Deploy to production with the active profile
$ wrangler-profiles deploy production

# Run any wrangler command
$ wrangler-profiles run kv:namespace list
$ wrangler-profiles run d1 list
$ wrangler-profiles run tail my-worker
```

## License

MIT

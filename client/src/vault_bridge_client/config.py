"""Configuration loader — reads from ~/.vault-bridge/.env"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


CONFIG_DIR = Path.home() / ".vault-bridge"
ENV_FILE = CONFIG_DIR / ".env"

DEFAULT_RELAY_URL = "wss://vault-bridge.the-empyrean.com/ws"


@dataclass
class Config:
    relay_url: str
    token: str
    vault_path: Path

    @staticmethod
    def load() -> "Config":
        """Load config from env file, then environment variables (env vars win)."""
        # Load .env file if it exists
        if ENV_FILE.exists():
            _load_dotenv(ENV_FILE)

        token = os.environ.get("VAULT_BRIDGE_TOKEN", "")
        if not token:
            raise SystemExit(
                f"VAULT_BRIDGE_TOKEN not set. Run 'vault-bridge setup' or set it in {ENV_FILE}"
            )

        vault_path_str = os.environ.get("VAULT_BRIDGE_VAULT_PATH", "")
        if not vault_path_str:
            raise SystemExit(
                f"VAULT_BRIDGE_VAULT_PATH not set. Run 'vault-bridge setup' or set it in {ENV_FILE}"
            )

        vault_path = Path(vault_path_str).expanduser().resolve()
        if not vault_path.is_dir():
            raise SystemExit(f"Vault path does not exist: {vault_path}")

        relay_url = os.environ.get("VAULT_BRIDGE_RELAY_URL", DEFAULT_RELAY_URL)

        return Config(
            relay_url=relay_url,
            token=token,
            vault_path=vault_path,
        )


def _load_dotenv(path: Path) -> None:
    """Minimal .env parser — no dependency needed at this stage."""
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip("\"'")
        # Don't overwrite existing env vars
        if key not in os.environ:
            os.environ[key] = value

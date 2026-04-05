"""Entry point for `python -m vault_bridge_client`."""

import asyncio
import logging
import sys

from .config import Config
from .client import run


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )

    config = Config.load()
    logging.getLogger("vault-bridge-client").info(
        "Vault: %s | Relay: %s", config.vault_path, config.relay_url
    )

    try:
        asyncio.run(run(config.relay_url, config.token, config.vault_path))
    except KeyboardInterrupt:
        print("\nStopped.")
        sys.exit(0)


if __name__ == "__main__":
    main()

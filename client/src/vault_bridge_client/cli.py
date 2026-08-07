"""CLI entry points for vault-bridge-client.

Commands:
    vault-bridge setup            Interactive config wizard
    vault-bridge start            Connect to relay (foreground)
    vault-bridge status           Check connection config
    vault-bridge install-service  Install as background service (Windows/Linux)
"""

from __future__ import annotations

import asyncio
import logging
import sys
from pathlib import Path

import click

from .config import CONFIG_DIR, ENV_FILE, DEFAULT_RELAY_URL


@click.group()
@click.version_option(package_name="vault-bridge-client")
def cli():
    """Vault Bridge Client — connect your Obsidian vault to Claude.ai."""
    pass


@cli.command()
def setup():
    """Interactive setup wizard — configure vault path and token."""
    click.echo("Vault Bridge Client Setup\n")

    # Vault path
    default_vault = ""
    vault_path_str = click.prompt(
        "Path to your Obsidian vault",
        default=default_vault,
        type=str,
    )
    vault_path = Path(vault_path_str).expanduser().resolve()
    if not vault_path.is_dir():
        click.echo(f"Warning: {vault_path} does not exist yet. Continuing anyway.")

    # Token
    token = click.prompt("Your Vault Bridge token (from your admin)", type=str)
    if not token.strip():
        click.echo("Error: token cannot be empty.")
        sys.exit(1)

    # Relay URL
    relay_url = click.prompt(
        "Relay WebSocket URL",
        default=DEFAULT_RELAY_URL,
        type=str,
    )

    # Write config
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    env_lines = [
        f"VAULT_BRIDGE_TOKEN={token.strip()}",
        f"VAULT_BRIDGE_VAULT_PATH={vault_path}",
        f"VAULT_BRIDGE_RELAY_URL={relay_url}",
    ]
    ENV_FILE.write_text("\n".join(env_lines) + "\n")

    click.echo(f"\nConfig saved to {ENV_FILE}")
    click.echo(f"  Vault:  {vault_path}")
    click.echo(f"  Relay:  {relay_url}")
    click.echo(f"  Token:  {token[:8]}...")
    click.echo("\nRun 'vault-bridge start' to connect.")


@cli.command()
def start():
    """Connect to the relay and listen for tool calls."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )

    from .config import Config
    from .client import run

    config = Config.load()
    log = logging.getLogger("vault-bridge-client")
    log.info("Vault: %s", config.vault_path)
    log.info("Relay: %s", config.relay_url)

    try:
        asyncio.run(run(config.relay_url, config.token, config.vault_path))
    except KeyboardInterrupt:
        click.echo("\nStopped.")


@cli.command()
def status():
    """Show current configuration and check readiness."""
    if not ENV_FILE.exists():
        click.echo(f"Not configured. Run 'vault-bridge setup' first.")
        click.echo(f"  Expected config at: {ENV_FILE}")
        sys.exit(1)

    from .config import Config

    try:
        config = Config.load()
    except SystemExit as e:
        click.echo(f"Config error: {e}")
        sys.exit(1)

    click.echo("Vault Bridge Client Status\n")
    click.echo(f"  Config:  {ENV_FILE}")
    click.echo(f"  Vault:   {config.vault_path}")
    click.echo(f"  Relay:   {config.relay_url}")
    click.echo(f"  Token:   {config.token[:8]}...")

    if config.vault_path.is_dir():
        count = sum(1 for _ in config.vault_path.rglob("*.md"))
        click.echo(f"  Files:   {count} markdown files found")
    else:
        click.echo(f"  Warning: vault path does not exist")

    click.echo("\nRun 'vault-bridge start' to connect.")


@cli.command("install-service")
def install_service():
    """Install as a background service (auto-start on login)."""
    if sys.platform == "win32":
        _install_windows_service()
    elif sys.platform == "linux":
        _install_linux_service()
    else:
        click.echo(f"Unsupported platform: {sys.platform}")
        click.echo("Run 'vault-bridge start' manually or set up your own service.")
        sys.exit(1)


def _install_windows_service():
    """Create a Windows startup shortcut via VBScript."""
    import shutil

    python_path = shutil.which("vault-bridge")
    if not python_path:
        python_path = f"{sys.executable} -m vault_bridge_client"

    startup_dir = Path.home() / "AppData" / "Roaming" / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"
    if not startup_dir.is_dir():
        click.echo(f"Startup directory not found: {startup_dir}")
        sys.exit(1)

    # VBScript to run without visible console window
    vbs_path = startup_dir / "vault-bridge.vbs"
    vbs_content = (
        'Set WshShell = CreateObject("WScript.Shell")\n'
        f'WshShell.Run "vault-bridge start", 0, False\n'
    )
    vbs_path.write_text(vbs_content)
    click.echo(f"Startup script installed: {vbs_path}")
    click.echo("Vault Bridge will auto-start on login.")


def _install_linux_service():
    """Create a systemd user service."""
    import shutil

    vault_bridge_bin = shutil.which("vault-bridge") or f"{sys.executable} -m vault_bridge_client"

    service_dir = Path.home() / ".config" / "systemd" / "user"
    service_dir.mkdir(parents=True, exist_ok=True)
    service_path = service_dir / "vault-bridge.service"

    service_content = f"""[Unit]
Description=Vault Bridge Client
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart={vault_bridge_bin} start
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
"""
    service_path.write_text(service_content)
    click.echo(f"Service file written: {service_path}")
    click.echo("Enable with:")
    click.echo("  systemctl --user daemon-reload")
    click.echo("  systemctl --user enable --now vault-bridge")

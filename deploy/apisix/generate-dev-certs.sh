#!/usr/bin/env bash
# Create self-signed TLS cert and render apisix.generated.yaml (APISIX standalone expects PEM inline in apisix.yaml).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERT_DIR="$DIR/certs"
CONF_DIR="$DIR/apisix_conf"
GEN="$CONF_DIR/apisix.generated.yaml"
# Docker mounts a missing file path as an empty directory — APISIX then fails with "apisix.yaml: Is a directory".
if [ -d "$GEN" ]; then
  echo "Removing mistaken directory $GEN (create the file with this script before docker compose)." >&2
  rm -rf "$GEN"
fi
mkdir -p "$CERT_DIR"
openssl req -x509 -nodes -newkey rsa:2048 \
  -keyout "$CERT_DIR/server.key" \
  -out "$CERT_DIR/server.crt" \
  -days 825 \
  -subj "/CN=${APISIX_TLS_SNI:-localhost}"
python3 - "$DIR" <<'PY'
import sys
from pathlib import Path

def yaml_literal_block(pem: str, indent: str) -> str:
    """First line follows template indent; continuation lines are indented for YAML | blocks."""
    lines = pem.strip().split("\n")
    if not lines:
        return ""
    first = lines[0]
    rest = "\n".join(indent + line for line in lines[1:])
    return first + ("\n" + rest if rest else "")

root = Path(sys.argv[1])
cert = (root / "certs" / "server.crt").read_text()
key = (root / "certs" / "server.key").read_text()
tpl = (root / "apisix_conf" / "apisix.yaml.template").read_text()
ind = "      "
out = tpl.replace("<<<TLS_CERT_PEM>>>", yaml_literal_block(cert, ind))
out = out.replace("<<<TLS_KEY_PEM>>>", yaml_literal_block(key, ind))
(root / "apisix_conf" / "apisix.generated.yaml").write_text(out)
print("Wrote", root / "apisix_conf" / "apisix.generated.yaml")
PY

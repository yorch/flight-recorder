#!/bin/sh
# Writes the fixture test secrets into ./secrets/ (gitignored). Never touches
# ANTHROPIC_API_KEY / OPENAI_API_KEY files.
set -eu
mkdir -p secrets
printf 'agent@example.test' > secrets/TEST_USER_EMAIL
printf 's3cret-test-pw' > secrets/TEST_USER_PASSWORD
echo "wrote secrets/TEST_USER_EMAIL and secrets/TEST_USER_PASSWORD"

# List the available recipes
default:
  @just --list

# Lock the Python and Node.js dependencies
lock:
  uv pip compile --python-version 3.8 --generate-hashes -o ./requirements.txt ./pyproject.toml
  npm install --package-lock-only --ignore-scripts

# Install the dependencies for the bundled tool
setup:
  uv pip sync --require-hashes ./requirements.txt --target ./bundled/libs

# Install everything needed for local development
install: setup
  npm ci --ignore-scripts

# Check for code quality and type errors
check:
  uv run --dev ruff check ./bundled/tool ./build ./scripts
  uv run --dev ruff format --check ./bundled/tool ./build ./scripts
  uv run --dev ty check ./scripts/release.py
  uv run --dev ty check bundled/tool/find_ty_binary_path.py
  npm run fmt-check
  npm run lint
  npm run tsc

# Format the code
fmt:
  uv run --dev ruff check --fix ./bundled/tool ./build ./scripts
  uv run --dev ruff format ./bundled/tool ./build ./scripts
  uv run --dev ty check --fix ./scripts/release.py
  uv run --dev ty check --fix bundled/tool/find_ty_binary_path.py
  npm run fmt

# Build the VS Code package
build-package: setup
  npm ci --ignore-scripts
  npm run vsce-package

# Clean out the build artifacts
clean:
  rm -rf out
  rm -rf node_modules
  rm -rf .vscode-test
  rm -rf bundled/libs

# Run the release script
release *ARGS:
  uv run scripts/release.py {{ARGS}}

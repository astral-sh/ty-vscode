# List the available recipes
default:
  @just --list

# Lock the Python and Node.js dependencies
lock:
  uv lock
  npm install --package-lock-only --ignore-scripts

# Install the dependencies for the bundled tool
setup:
  uv export --quiet --locked --only-group bundle | uv pip sync --require-hashes - --target ./bundled/libs

# Install everything needed for local development
install: setup
  uv sync --locked --python=3.12
  npm ci --ignore-scripts

# Check for code quality and type errors
check:
  uv run --locked --python=3.12 ruff check ./bundled/tool ./build ./scripts
  uv run --locked --python=3.12 ruff format --check ./bundled/tool ./build ./scripts
  uv run --locked --python=3.12 ty check scripts/release.py --python-version=3.12 --error-on-warning
  uv run --locked --python=3.12 ty check bundled/tool/find_ty_binary_path.py --python-version=3.8 --error-on-warning
  npm run fmt-check
  npm run lint
  npm run tsc

# Format the code
fmt:
  uv run --locked --python=3.12 ruff check --fix ./bundled/tool ./build ./scripts
  uv run --locked --python=3.12 ruff format ./bundled/tool ./build ./scripts
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

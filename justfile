# List the available recipes
default:
  @just --list

# Lock the Python and Node.js dependencies
lock:
  uv pip compile --python-version 3.8 --generate-hashes -o ./requirements.txt ./pyproject.toml
  npm install --package-lock-only

# Install the dependencies for the bundled tool
setup:
  uv pip sync --require-hashes ./requirements.txt --target ./bundled/libs

# Install everything needed for local development
install: setup
  npm ci

# Check for code quality and type errors
check:
  uvx ruff check ./bundled/tool ./build ./scripts
  uvx ruff format --check ./bundled/tool ./build ./scripts
  uvx --with=types-requests --with=tomli --with=tomlkit --with=packaging --with=rich-argparse mypy scripts/release.py --strict --warn-unreachable --enable-error-code=possibly-undefined --enable-error-code=redundant-expr --enable-error-code=truthy-bool
  uvx mypy bundled/tool/find_ty_binary_path.py --strict --warn-unreachable --enable-error-code=possibly-undefined --enable-error-code=redundant-expr --enable-error-code=truthy-bool
  npm run fmt-check
  npm run lint
  npm run tsc

# Format the code
fmt:
  uvx ruff check --fix ./bundled/tool ./build ./scripts
  uvx ruff format ./bundled/tool ./build ./scripts
  npm run fmt

# Build the VS Code package
build-package: setup
  npm ci
  npm run vsce-package

# Clean out the build artifacts
clean:
  rm -rf out
  rm -rf node_modules
  rm -rf .vscode-test
  rm -rf bundled/libs

# Run the release script
release *ARGS:
  uv run --python=3.8 scripts/release.py {{ARGS}}

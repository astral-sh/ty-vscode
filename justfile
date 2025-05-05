default: fmt check

lock:
  uv pip compile --python-version 3.8 --generate-hashes -o ./requirements.txt ./pyproject.toml
  npm install --package-lock-only

setup:
  uv pip sync --require-hashes ./requirements.txt --target ./bundled/libs

install:
  npm ci

check:
  ruff check ./bundled/tool ./build ./scripts
  ruff format --check ./bundled/tool ./build ./scripts
  uvx --with=types-requests --with=tomli --with=tomlkit --with=packaging --with=rich-argparse mypy scripts/release.py --strict --warn-unreachable --enable-error-code=possibly-undefined --enable-error-code=redundant-expr --enable-error-code=truthy-bool
  uvx mypy bundled/tool/find_ty_binary_path.py --strict --warn-unreachable --enable-error-code=possibly-undefined --enable-error-code=redundant-expr --enable-error-code=truthy-bool
  npm run fmt-check
  npm run lint
  npm run tsc

fmt:
  ruff check --fix ./bundled/tool ./build ./scripts
  ruff format ./bundled/tool ./build ./scripts
  npm run fmt

build-package: setup
  npm ci
  npm run vsce-package

clean:
  rm -rf out
  rm -rf node_modules
  rm -rf .vscode-test
  rm -rf bundled/libs

release:
  uv run --python=3.7 scripts/release.py

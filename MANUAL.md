# Manual Setup

For most students, the Dockerized workflow in the main [README](README.md) is the fastest path. This
document covers the manual alternative — useful if you prefer to run everything natively on your
host, don't have Docker available, or want full control over your editor and Python environment.

## Prerequisites

- **Python 3.13** (3.14 is not supported yet because `ale-py` has no 3.14 wheels).
- **[Poetry](https://python-poetry.org/) 2.x** for dependency management.
- **Node 20+** and **npm** — only if you want to build the DRL-ZH Companion extension from source.
- **System libraries** for the environments:
  - Linux (Debian/Ubuntu): `build-essential swig libgl1 libegl1`
  - macOS: `brew install swig` (Apple-clang supplies the rest)
  - Windows: use WSL2 and follow the Linux instructions

## Python environment

The canonical dependency set ships with CUDA-capable PyTorch. If you don't have an NVIDIA GPU, use
the CPU-only variant under `cpu/` instead — it installs a ~200 MB torch wheel instead of ~2.5 GB.

```bash
# Create and activate a Python 3.13 venv. The uv-based flow is recommended:
uv venv --python 3.13 --seed
source .venv/bin/activate

# Install dependencies — pick ONE:
poetry install --no-root              # GPU / CUDA torch
poetry -C cpu install --no-root       # CPU-only torch
```

`--no-root` tells Poetry not to try installing the `drl-zh` metadata itself (this repo isn't a
Python package, just a dependency container).

## Register the Jupyter kernel

So VS Code's kernel picker shows the environment as `Python (drl-zh)`:

```bash
python -m ipykernel install --user \
    --name "drl-zh-env" --display-name "Python (drl-zh)"
```

## VS Code extensions

Install these from the VS Code marketplace to match the Dockerized environment:

| Extension                                                                                        | Publisher                   | Purpose                                  |
| ------------------------------------------------------------------------------------------------ | --------------------------- | ---------------------------------------- |
| [Python](https://marketplace.visualstudio.com/items?itemName=ms-python.python)                   | `ms-python.python`          | Python language support                  |
| [Jupyter](https://marketplace.visualstudio.com/items?itemName=ms-toolsai.jupyter)                | `ms-toolsai.jupyter`        | Notebook UI + kernel picker              |
| [Black Formatter](https://marketplace.visualstudio.com/items?itemName=ms-python.black-formatter) | `ms-python.black-formatter` | Formatter matching `pyproject.toml`      |
| [Markdown Mermaid](https://marketplace.visualstudio.com/items?itemName=bierner.markdown-mermaid) | `bierner.markdown-mermaid`  | Mermaid diagrams in Markdown & notebooks |

After the extensions are installed, point the Python extension at the venv: **Command Palette →
`Python: Select Interpreter` → `./.venv/bin/python`**.

## DRL-ZH AI Companion extension (optional)

The Companion is a VS Code extension that ships inside the Dockerized environment. To build and
install it manually:

```bash
cd extension
npm ci
npm run build
npx vsce package -o companion.vsix
code --install-extension companion.vsix
```

Then reload VS Code. Bring your own LLM API key (Gemini recommended, or OpenAI, Anthropic, Groq) and
configure it via the Companion's settings panel.

## Running the notebooks

```bash
# From the repo root, with the venv activated:
jupyter notebook
# — or just open 00_Intro.ipynb in VS Code and run cells there.
```

## Troubleshooting

- **`gymnasium[box2d]` fails to build** — you're missing `swig` or a C toolchain. See the
  system-libraries list above.
- **MuJoCo headless render errors** — set `MUJOCO_GL=egl` (Linux) or `MUJOCO_GL=glfw` (macOS) in
  your environment before running the notebook.
- **Kernel not visible in VS Code** — re-run the `ipykernel install` step above, then
  `Command Palette → Developer: Reload Window`.
- **Poetry resolving forever on torch** — if you're using `cpu/pyproject.toml` and have no
  `cpu/poetry.lock`, Poetry will download many wheels to resolve. Prefer the committed
  `cpu/poetry.lock` (just run `poetry -C cpu install`).

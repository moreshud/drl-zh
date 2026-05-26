# Deep Reinforcement Learning: Zero to Hero!

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Python 3.13.x](https://img.shields.io/badge/python-3.13.x-blue.svg)](https://www.python.org/downloads/)
[![Code style: black](https://img.shields.io/badge/code%20style-black-000000.svg)](https://github.com/psf/black)

Welcome to [drlzh.ai](https://drlzh.ai): a hands-on deep reinforcement learning course where you
build the algorithms, not just read about them.

<div style="width: 75%; margin: auto;">
  <img src="assets/drlzh-splash.gif">
</div>

Start from MDPs and tabular RL, then work your way to the algorithms behind Atari agents,
continuous-control robots, AlphaZero-style planning, RLHF for language models, Decision
Transformers, VLA-style policies, world models, Dreamer, and meta-learning.

The root notebooks are the exercise track: code is intentionally replaced with guided `TODO`
sections. The [`solution/`](solution/) notebooks contain the complete, runnable versions, so you can
unblock yourself without leaving the course.

## Curriculum

| Notebooks | Track                | You build                                                                   |
| --------- | -------------------- | --------------------------------------------------------------------------- |
| `00`-`07` | Foundations          | MDPs, tabular RL, DQN, REINFORCE, actor-critic methods, DDPG, TD3, SAC, PPO |
| `08`-`10` | Breaking assumptions | RND curiosity, multi-agent RL, offline RL with BC and IQL                   |
| `11`      | Planning             | Monte Carlo Tree Search, self-play, AlphaZero-style policy/value learning   |
| `12`-`13` | Modern AI stack      | RLHF with PPO, DPO, GRPO, Decision Transformers, and NanoVLA (`DTVLA`)      |
| `14`      | Production           | TensorBoard, checkpointing, debugging, multiple seeds, Ray, Optuna          |
| `15`-`16` | World models         | MBPO with SAC, then `DR3AM`/Dreamer with RSSM latent imagination            |
| `17`-`18` | Meta + wrap-up       | MAML, FOMAML, fast adaptation, and course conclusion                        |

The foundations are meant to be done in order. The advanced notebooks are self-contained, but the
numbering gives you a good default path from exploration to the course capstone.

## AI Companion

The Docker workspace includes the **DRL-ZH AI Companion**, a VS Code extension built for this
course. It knows which notebook and `TODO` you are working on, offers Socratic hints instead of
spoilers, and supports text or voice mode. Bring your own LLM key: Gemini is the default, with
OpenAI, Anthropic, and Groq supported too.

## Quick Start

The recommended setup is Docker: it gives you code-server, the notebooks, Python `>=3.13,<3.14`, the
Jupyter kernel, dependencies, and the AI Companion in one reproducible workspace.

1. Install Docker and Git, then clone this repository and `cd` into it.
2. On Linux/macOS, run `printf "UID=$(id -u)\nGID=$(id -g)\n" > .env` so files are owned by you.
3. Start the default environment:

   ```bash
   docker compose up --build -d
   ```

4. Open `http://localhost:8080` in a Chromium-based browser and select the `Python (drl-zh)` kernel.
5. Open `00_Intro.ipynb` and start filling in TODOs.

For NVIDIA GPU access, use:

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up --build -d
```

For a smaller CPU-only image, use:

```bash
docker compose -f docker-compose.yml -f docker-compose.cpu.yml up --build -d
```

Prefer a native setup? See [MANUAL.md](MANUAL.md) for Python, Poetry, VS Code, and Companion
instructions.

## Prerequisites

You should be comfortable with Python, PyTorch basics, and the usual math behind ML: probability,
statistics, linear algebra, and derivatives. The notebooks teach the RL, but they assume you can
read and modify real training code.

## License

MIT. See [LICENSE](LICENSE).

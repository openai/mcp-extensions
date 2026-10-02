"""Build the distribution and import its installed public packages."""

import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory


def main() -> None:
    project = Path(__file__).resolve().parents[1]
    with TemporaryDirectory(prefix="mcp-extensions-package-") as temporary:
        root = Path(temporary)
        subprocess.run(
            [sys.executable, "-m", "build", "--outdir", str(root / "dist")],
            cwd=project,
            check=True,
        )
        (wheel,) = (root / "dist").glob("*.whl")
        consumer = (root / "consumer").resolve()
        subprocess.run(
            [
                sys.executable,
                "-m",
                "pip",
                "install",
                "--no-deps",
                "--target",
                str(consumer),
                str(wheel),
            ],
            check=True,
        )
        subprocess.run(
            [
                sys.executable,
                "-I",
                "-c",
                """
import pathlib
import sys
sys.path.insert(0, sys.argv[1])
import openai_mcp_extensions
import openai_mcp_form_protocol
from openai_mcp_extensions import OpenAIExtensions, OpenAISettings
from openai_mcp_extensions.form import request_form_input, resource_input
for package in (openai_mcp_extensions, openai_mcp_form_protocol):
    assert pathlib.Path(package.__file__).resolve().is_relative_to(pathlib.Path(sys.argv[1]))
for value in (OpenAIExtensions, OpenAISettings, request_form_input, resource_input):
    assert callable(value)
""",
                str(consumer),
            ],
            cwd=root,
            check=True,
        )


if __name__ == "__main__":
    main()

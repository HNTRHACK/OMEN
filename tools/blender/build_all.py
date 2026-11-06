"""Rebuild every OMEN asset into public/models/.

Needs Python 3.11 with Blender's `bpy` module:   python3.11 -m pip install bpy
Then:   python3.11 tools/blender/build_all.py          (add --preview for Cycles previews)
"""
import os
import subprocess
import sys

here = os.path.dirname(os.path.abspath(__file__))
extra = ["--preview"] if "--preview" in sys.argv else []
for script, args in (("buildings.py", [] if extra else ["--no-preview"]), ("props.py", extra), ("characters.py", [])):
    print(f"== {script}")
    subprocess.run([sys.executable, os.path.join(here, script), *args], check=True)

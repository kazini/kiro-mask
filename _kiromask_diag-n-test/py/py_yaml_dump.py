#!/usr/bin/env python3
"""Print a YAML file as canonical JSON using PyYAML (the reference implementation)."""
import json, sys, yaml
print(json.dumps(yaml.safe_load(open(sys.argv[1], encoding="utf-8")), sort_keys=True, default=str, ensure_ascii=False))

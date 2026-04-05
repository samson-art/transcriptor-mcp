# Contributing

Thanks for helping improve this project.

## Before you start

- Check [open issues](https://github.com/samson-art/transcriptor-mcp/issues) and existing PRs to avoid duplicate work.
- For larger changes, opening an issue first helps align on approach.

## Development setup

```bash
npm ci
npm run build
```

## Checks

Before opening a PR, run the same checks CI uses:

```bash
make prepare   # lint + format
make check     # format-check, lint, typecheck, tests, build, Docker smoke
```

If Docker is unavailable locally, at minimum run `make check-no-smoke` (everything except the Docker-based smoke test).

## Pull requests

- One logical change per PR when possible.
- Keep commits focused; maintainers may squash on merge.
- Add or update tests when behavior changes.

## License

By contributing, you agree that your contributions are licensed under the same terms as the project ([MIT License](LICENSE)).

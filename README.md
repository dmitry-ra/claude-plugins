# claude-plugins

Original Claude Code plugins, published as the `dmitry-lab` marketplace.

## Plugins

- **file-channel** - a file-backed channel for Claude Code. An external process
  appends lines to a channel inbox; the plugin injects them into the live
  session, and Claude writes back to the outbox. Sessions compose into
  pipelines: one session's outbox can feed another session's inbox.

## Use

Add the marketplace, then install a plugin:

    claude plugin marketplace add dmitry-ra/claude-plugins
    claude plugin install file-channel@dmitry-lab

## License

MIT. See LICENSE.

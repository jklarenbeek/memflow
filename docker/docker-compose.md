# Docker Compose Configuration & Deployment

This document outlines the extended configuration options available when running MemFlow via `docker/docker-compose.yml`.

## Persistent Logging

MemFlow automatically logs all system events, errors, and traces to both the **Console** and a **File transport** simultaneously.

When running through Docker Compose, you can configure and persist these logs to your host machine.

### Configuration Variables

You can customize the logger using environment variables (in your `.env` or in `docker-compose.yml`):

- **`LOG_FILE_PATH`** (Default: `logs/memflow.log`)
  Dictates the internal container path where logs are written. 
- **`LOG_LEVEL`** (Default: `info`)
  Controls the verbosity of the output (`debug`, `info`, `warn`, `error`).

### Accessing Logs on the Host

The `memflow` service in `docker-compose.yml` binds the container's `/app/logs` directory directly to the host.

```yaml
    volumes:
      - ./logs:/app/logs
```

Because of this volume mount, any log files written by the application are automatically synced to the `docker/logs/` folder on your host machine, allowing you to tail, grep, or rotate them without entering the container.

# GoPlan Backend Template

## Overview

This repository is a minimal backend starter for building new Django/DRF applications.
It includes a ready-to-run local stack with PostgreSQL and Podman Compose.
Use it as a clean foundation, then add your domain apps and APIs.

## Tech Stack

- Django
- Django REST Framework
- PostgreSQL
- Podman Compose

## Quick Start

```bash
podman compose up --build
```

Backend health check:

- Open `http://localhost:8000/`

## Project Structure

- `backend/` -> Django project and apps
- `podman-compose.yml` -> local services orchestration
- `.devcontainer/` -> development container setup
- `explain/` -> project explanation documents

## Notes

- Review environment files before running:
  - `backend/.env`
  - `backend/db.env`
- Common migration commands:
  - `podman compose exec backend python manage.py makemigrations`
  - `podman compose exec backend python manage.py migrate`

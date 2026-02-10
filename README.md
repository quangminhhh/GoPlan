# GoPlan Starter Template

## Overview

This repository is a minimal starter for new web applications with a Django/DRF backend
and a Next.js frontend baseline.
It includes a ready-to-run local stack with PostgreSQL and Podman Compose.
Use it as a clean foundation, then add your domain apps and APIs.

## Tech Stack

- Django
- Django REST Framework
- Next.js
- Axios
- PostgreSQL
- Podman Compose

## Quick Start

```bash
podman compose up --build
```

Health checks:

- Backend API: `http://localhost:8000/api/health`
- Frontend app: `http://localhost:3000`

## Project Structure

- `backend/` -> Django project and apps
- `frontend/` -> Next.js app and API client baseline
- `podman-compose.yml` -> local services orchestration
- `.devcontainer/` -> development container setup
- `explain/` -> project explanation documents

## Notes

- Review environment files before running:
  - `backend/.env`
  - `backend/db.env`
- Frontend API base URL:
  - `NEXT_PUBLIC_API_BASE_URL=http://localhost:8000`
- Common migration commands:
  - `podman compose exec backend python manage.py makemigrations`
  - `podman compose exec backend python manage.py migrate`

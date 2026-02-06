# Django Skeleton With Podman

This project is a very clean backend template using Django, Django REST Framework, and PostgreSQL. Everything runs inside Podman so you can clone the repo and start coding a new backend immediately.

## What is inside

- **Django 5 + DRF** with the most common settings ready.
- **PostgreSQL 16** already wired by `backend/.env` and `backend/db.env`.
- **Podman Compose** (`podman-compose.yml`) to start the database and the backend together.
- **Devcontainer** (`.devcontainer/devcontainer.json`) so VS Code works inside the same Python environment as the container.
- **Containerfile** to build a small Python 3.12 image with the packages from `requirements.txt`.

## How to start

1. Install Podman on your machine and make sure it runs correctly.
2. Update every TODO comment (service names, image names, database values, secret key, etc.) for your new project.
3. Build and run the stack:

   ```bash
   podman compose up --build
   ```

4. Open `http://localhost:8000` to check the backend.

## Daily tips

- **Environment files:** always review `backend/.env` and `backend/db.env` before starting the containers.
- **Migrations:** when your models change, run `podman compose exec backend python manage.py makemigrations`, then restart or run `podman compose up` again so migrations are applied automatically.
- **Optional packages:** uncomment JWT or Daphne in `requirements.txt` only when you really need them. This keeps the base image small.
- **Frontend placeholder:** the `frontend/` folder is empty on purpose. Add your UI stack there if you need one.

## When cloning for a new project

- Rename the services, image tags, and container names in `podman-compose.yml`.
- Update database values in both `backend/.env` and `backend/db.env`.
- Replace the secret key in `backend/.env`.
- Enable extra services (MongoDB, Redis, Daphne/ASGI) when your project requires them.

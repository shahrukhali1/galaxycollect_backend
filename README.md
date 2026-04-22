# Backend Deployment

This folder contains the standalone backend API for separate Vercel deployment.

## Local run

```bash
cd backend
npm install
npm run dev
```

## Deploy on Vercel (separate project)

1. Import the same GitHub repo as a new Vercel project.
2. Set **Root Directory** to `backend`.
3. Add env vars from `backend/.env.example`.
4. Deploy.

## Frontend connection

In frontend project env vars:

```bash
VITE_API_BASE_URL=https://your-backend.vercel.app
```


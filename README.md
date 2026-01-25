# 🛒 Cartlify – Modern E-Commerce Platform

## 📌 Overview

<!-- Project preview image (placeholder) -->

[![Homepage](./assets/images/home_preview.jpg 'Cartlify')](#)

**Cartlify** is a backend-focused, full-stack e-commerce platform built as a **production-grade portfolio project**.

The project emphasizes **clean architecture, database design, security, and scalability**, rather than quick feature delivery. Cartlify is intentionally developed step-by-step to reflect how real commercial systems evolve over time.

> ⚠️ **Project status:** Active development  
> Core architecture and database design are completed.  
> Features are implemented incrementally according to a strict technical roadmap.

---

## 🎯 Mission

To build a realistic e-commerce system that demonstrates:

- strong backend engineering skills
- deep understanding of PostgreSQL & data integrity
- secure authentication & authorization flows
- scalable architecture suitable for real production use

---

## ✨ Features

### 👤 Users & Authentication

- User registration & login
- OAuth authentication (Google / GitHub / Facebook)
- JWT-based authentication (HttpOnly cookies)
- Role-based access control: `USER`, `ADMIN`, `ROOT`
- User preferences (language, theme)
- Favorites list

### 🛍 Products & Catalog

- Product categories
- Product CRUD (ADMIN / ROOT)
- Image uploads via Cloudinary
- Product ratings & reviews
- View counters
- Popularity calculation (orders, views, ratings)
- Manual popularity override (ROOT)

### 🧾 Orders

- Cart & checkout flow
- Order price snapshots (price consistency)
- Order statuses: Pending → Processing → Shipped → Delivered
- User order history
- Admin order management

### ⭐ Reviews

- Reviews from verified users only
- Rating aggregation (average & count)
- Like / dislike system
- Automatic product rating recalculation

### 💬 Chat (Planned)

- Real-time messaging via WebSockets
- Guest & authenticated chats
- Admin / support monitoring

### 📊 Admin Panel & Analytics

- Users & orders overview
- Top products (by views & orders)
- Revenue metrics
- Manual popularity control
- Admin audit logging (planned)

### 🌍 UI / SSR

- Server-side rendering (Fastify + Handlebars)
- Pages: Home, Catalog, Product, Cart, Admin
- Light / Dark theme
- Multi-language support (UA / EN)
- Cookie consent banner

---

## 🛠 Tech Stack

### 🖥 Backend

![NodeJS](https://img.shields.io/badge/node.js-6DA55F?style=for-the-badge&logo=node.js&logoColor=white)
![Fastify](https://img.shields.io/badge/fastify-000000?style=for-the-badge&logo=fastify&logoColor=white)
![TypeScript](https://img.shields.io/badge/typescript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/postgresql-316192?style=for-the-badge&logo=postgresql&logoColor=white)
![Prisma](https://img.shields.io/badge/prisma-2D3748?style=for-the-badge&logo=prisma&logoColor=white)
![GraphQL](https://img.shields.io/badge/graphql-E10098?style=for-the-badge&logo=graphql&logoColor=white)
![JWT](https://img.shields.io/badge/jwt-black?style=for-the-badge&logo=jsonwebtokens)
![Redis](https://img.shields.io/badge/redis-DC382D?style=for-the-badge&logo=redis&logoColor=white)
![Cloudinary](https://img.shields.io/badge/cloudinary-3448C5?style=for-the-badge&logo=cloudinary&logoColor=white)
![Docker](https://img.shields.io/badge/docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![Railway](https://img.shields.io/badge/railway-0B0D0E?style=for-the-badge&logo=railway&logoColor=white)

> Also used: Supabase Auth, Socket.io / Fastify WS, Jest, Supertest, ESLint, Prettier, dotenv

---

## 🧠 Architecture Highlights

- Modular service-oriented architecture
- Clear separation of concerns:
  - GraphQL resolvers
  - Services (business logic)
  - Database layer

- Strict TypeScript everywhere
- PostgreSQL **Row Level Security (RLS)**
- Centralized caching strategy
- Transaction-safe order processing
- Prepared for analytics via SQL views & materialized views

---

## 🗺 Roadmap

- [x] Project architecture & database design
- [x] PostgreSQL roles, schemas & RLS baseline
- [x] Prisma models & migrations
- [x] Authentication & RBAC foundation
- [ ] Product & category module
- [ ] Orders & checkout
- [ ] Reviews & ratings
- [ ] Admin analytics
- [ ] Chat (WebSockets)
- [ ] Full test coverage
- [ ] CI/CD automation

---

## 🚧 Project Status

Cartlify is **not a finished product**.

This repository is intentionally public to demonstrate:

- architectural thinking
- backend-first development approach
- database design & data integrity
- ability to plan and build complex systems step-by-step

---

## 👨‍💻 Author

**Maksym Dziubanchuk**  
Backend Developer (Node.js / TypeScript / PostgreSQL)

Cartlify builds upon experience gained from previous full-stack projects and focuses on advancing backend engineering skills to a production-ready level.

---

## 📄 License

MIT (planned)

---

## 🔗 Links

- 📂 Repository: this repository
- 🚀 Deployment: planned
- 📊 Admin panel: planned

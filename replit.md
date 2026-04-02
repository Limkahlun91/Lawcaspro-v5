# Lawcaspro — Legal Operations System

## Overview
Lawcaspro is a multi-tenant legal operations SaaS specifically designed for Malaysian law firms, focusing on real estate conveyancing cases. It aims to streamline legal workflows, manage case-related documents, facilitate communication, and provide financial oversight for law firms. The platform offers dedicated workspaces for both firm users and a founder/platform administrator, ensuring secure and segregated data management. Its core capabilities include comprehensive case management, document generation from templates (DOCX and PDF), client and project tracking, role-based access control, and a robust communication hub. The system also supports detailed billing, quotation generation, and reporting functionalities, making it a complete solution for modern legal practices.

## User Preferences
- No emojis in UI
- Professional, dense data-rich interface for legal professionals
- Dark navy/slate theme with amber/gold accents

## System Architecture
Lawcaspro is built as a full-stack monorepo using `pnpm` workspaces. The frontend is developed with React, Vite, Tailwind CSS, Wouter for routing, and React Query for data fetching. The backend is an Express 5 API written in TypeScript, utilizing Drizzle ORM with a PostgreSQL database. Authentication is cookie-based, employing bcryptjs for password hashing and SHA-256 for token hashing, stored in HttpOnly cookies. The API contract is defined using OpenAPI specifications, with `orval` codegen generating typed React Query hooks and Zod validators for robust type safety and validation.

The architecture supports multi-tenancy with distinct routing for the `/platform/*` founder workspace and `/app/*` firm workspace. Firm context is derived from the session, not the URL. Document generation leverages `docxtemplater` for DOCX files and `pdf-lib` for PDFs, including a visual PDF mapping editor for overlaying text onto PDF templates with variable replacement.

Key UI/UX decisions include a professional, data-rich interface with a dark navy/slate theme accented by amber/gold. Navigation is structured with a consolidated sidebar (with unread notification badges for Communications) and tabbed layouts for settings and case details. Data modeling includes tables for firms, users, roles, permissions, developers, projects, clients, cases, and various case-related entities like workflow steps, notes, documents, billing entries, communication threads, and thread messages. A workflow engine dynamically generates case steps based on `purchaseMode` and `titleType`.

Communications follow a subject-based thread model: users create a "subject" (thread) per case, then chat within it. Unread tracking uses a `communication_read_status` table with per-user last-read timestamps. The sidebar shows an unread count badge that auto-refreshes every 30 seconds.

Projects support full CRUD including edit via the PATCH endpoint. The edit page pre-fills all fields from the existing project and accepts all fields including phase, developerName, title metadata, location fields, and extraFields (property types).

## External Dependencies
- **PostgreSQL**: Primary database for all application data, managed via Drizzle ORM.
- **Replit Object Storage (GCS)**: Used for storing document templates and generated case documents.
- **docxtemplater**: Library for generating DOCX documents from templates with data substitution.
- **pdf-lib**: Library for manipulating and generating PDF documents, including overlaying text based on visual mappings.
- **bcryptjs**: Used for secure password hashing.
- **Recharts**: Utilized for rendering charts and visualizations in reports and dashboards.
- **Tailwind CSS**: Utility-first CSS framework for styling the frontend.
- **Wouter**: A minimalistic routing library for React.
- **React Query**: For server state management and data fetching in the frontend.
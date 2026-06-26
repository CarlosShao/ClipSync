--
-- PostgreSQL database dump
--

\restrict nHdN7X3Ue7Qj638T0Gwct07b2ncMPAPY7Wna7MtArrpzZE2nEuPi2h5o6ubmuU5

-- Dumped from database version 15.18
-- Dumped by pg_dump version 15.18

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


--
-- Name: EXTENSION "uuid-ossp"; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';


--
-- Name: clipsync_update_search_vector(); Type: FUNCTION; Schema: public; Owner: clipsync
--

CREATE FUNCTION public.clipsync_update_search_vector() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
        NEW.search_vector := setweight(to_tsvector('simple', coalesce(NEW.content_type, '')), 'A') || setweight(to_tsvector('simple', coalesce(NEW.content_preview, '')), 'B');
        RETURN NEW;
      END $$;


ALTER FUNCTION public.clipsync_update_search_vector() OWNER TO clipsync;

--
-- Name: update_search_vector(); Type: FUNCTION; Schema: public; Owner: clipsync
--

CREATE FUNCTION public.update_search_vector() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.search_vector = to_tsvector('english', COALESCE(NEW.content_preview, ''));
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.update_search_vector() OWNER TO clipsync;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: clipboard_items; Type: TABLE; Schema: public; Owner: clipsync
--

CREATE TABLE public.clipboard_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    source_device_id uuid NOT NULL,
    content_type character varying(20) NOT NULL,
    content_encrypted text NOT NULL,
    content_preview text DEFAULT ''::text,
    content_size integer DEFAULT 0,
    metadata jsonb DEFAULT '{}'::jsonb,
    is_favorite boolean DEFAULT false,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    search_vector tsvector,
    content_diff text,
    CONSTRAINT clipboard_items_content_type_check CHECK (((content_type)::text = ANY ((ARRAY['text'::character varying, 'image'::character varying, 'file'::character varying, 'link'::character varying, 'code'::character varying])::text[])))
);


ALTER TABLE public.clipboard_items OWNER TO clipsync;

--
-- Name: device_sync_state; Type: TABLE; Schema: public; Owner: clipsync
--

CREATE TABLE public.device_sync_state (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id uuid NOT NULL,
    last_synced_item_id uuid,
    last_sync_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.device_sync_state OWNER TO clipsync;

--
-- Name: devices; Type: TABLE; Schema: public; Owner: clipsync
--

CREATE TABLE public.devices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    device_name character varying(100) NOT NULL,
    device_type character varying(20) NOT NULL,
    platform character varying(20) NOT NULL,
    platform_version character varying(50) DEFAULT ''::character varying,
    app_version character varying(20) DEFAULT '0.1.0'::character varying,
    public_key text,
    is_online boolean DEFAULT false,
    last_seen_at timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT devices_device_type_check CHECK (((device_type)::text = ANY ((ARRAY['desktop'::character varying, 'mobile'::character varying, 'tablet'::character varying, 'browser'::character varying])::text[]))),
    CONSTRAINT devices_platform_check CHECK (((platform)::text = ANY ((ARRAY['windows'::character varying, 'macos'::character varying, 'linux'::character varying, 'ios'::character varying, 'android'::character varying, 'browser'::character varying])::text[])))
);


ALTER TABLE public.devices OWNER TO clipsync;

--
-- Name: encryption_keys; Type: TABLE; Schema: public; Owner: clipsync
--

CREATE TABLE public.encryption_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key_name character varying(100) NOT NULL,
    key_value text NOT NULL,
    iv text NOT NULL,
    algorithm character varying(50) DEFAULT 'AES-256-GCM'::character varying,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.encryption_keys OWNER TO clipsync;

--
-- Name: file_versions; Type: TABLE; Schema: public; Owner: clipsync
--

CREATE TABLE public.file_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    clipboard_item_id uuid NOT NULL,
    user_id uuid NOT NULL,
    version_number integer DEFAULT 1 NOT NULL,
    content_encrypted text NOT NULL,
    content_preview text DEFAULT ''::text,
    content_size integer DEFAULT 0,
    metadata jsonb DEFAULT '{}'::jsonb,
    source_device_id uuid,
    change_description text DEFAULT ''::text,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.file_versions OWNER TO clipsync;

--
-- Name: invoices; Type: TABLE; Schema: public; Owner: clipsync
--

CREATE TABLE public.invoices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    order_id uuid,
    invoice_no character varying(100) NOT NULL,
    amount numeric(10,2) NOT NULL,
    tax numeric(10,2) DEFAULT 0,
    status character varying(20) DEFAULT 'draft'::character varying,
    invoice_url text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.invoices OWNER TO clipsync;

--
-- Name: notification_preferences; Type: TABLE; Schema: public; Owner: clipsync
--

CREATE TABLE public.notification_preferences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    notification_type character varying(50) NOT NULL,
    enabled boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.notification_preferences OWNER TO clipsync;

--
-- Name: payment_orders; Type: TABLE; Schema: public; Owner: clipsync
--

CREATE TABLE public.payment_orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    subscription_id uuid,
    order_no character varying(100) NOT NULL,
    amount numeric(10,2) NOT NULL,
    currency character varying(10) DEFAULT 'CNY'::character varying,
    payment_method character varying(50),
    status character varying(20) DEFAULT 'pending'::character varying,
    paid_at timestamp with time zone,
    transaction_id character varying(200),
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    payment_token_encrypted text
);


ALTER TABLE public.payment_orders OWNER TO clipsync;

--
-- Name: schema_versions; Type: TABLE; Schema: public; Owner: clipsync
--

CREATE TABLE public.schema_versions (
    version integer NOT NULL,
    description text NOT NULL,
    applied_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.schema_versions OWNER TO clipsync;

--
-- Name: subscription_plans; Type: TABLE; Schema: public; Owner: clipsync
--

CREATE TABLE public.subscription_plans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(50) NOT NULL,
    price numeric(10,2) DEFAULT 0 NOT NULL,
    currency character varying(10) DEFAULT 'CNY'::character varying,
    billing_cycle character varying(20) DEFAULT 'monthly'::character varying,
    max_devices integer DEFAULT 2,
    max_clipboard_items integer DEFAULT 50,
    max_file_size_mb integer DEFAULT 1,
    max_storage_mb integer DEFAULT 100,
    features jsonb DEFAULT '{}'::jsonb,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.subscription_plans OWNER TO clipsync;

--
-- Name: user_sessions; Type: TABLE; Schema: public; Owner: clipsync
--

CREATE TABLE public.user_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    device_name character varying(100) DEFAULT 'Unknown Device'::character varying,
    device_type character varying(20) DEFAULT 'browser'::character varying,
    platform character varying(50) DEFAULT 'unknown'::character varying,
    ip_address character varying(45),
    user_agent text,
    jwt_id character varying(100),
    is_active boolean DEFAULT true,
    last_active_at timestamp with time zone DEFAULT now(),
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT user_sessions_device_type_check CHECK (((device_type)::text = ANY ((ARRAY['desktop'::character varying, 'mobile'::character varying, 'tablet'::character varying, 'browser'::character varying])::text[])))
);


ALTER TABLE public.user_sessions OWNER TO clipsync;

--
-- Name: TABLE user_sessions; Type: COMMENT; Schema: public; Owner: clipsync
--

COMMENT ON TABLE public.user_sessions IS 'User session management for security tracking';


--
-- Name: user_subscriptions; Type: TABLE; Schema: public; Owner: clipsync
--

CREATE TABLE public.user_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    plan_id uuid NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying,
    current_period_start timestamp with time zone DEFAULT now(),
    current_period_end timestamp with time zone,
    cancel_at_period_end boolean DEFAULT false,
    trial_end timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    subscription_token_encrypted text
);


ALTER TABLE public.user_subscriptions OWNER TO clipsync;

--
-- Name: users; Type: TABLE; Schema: public; Owner: clipsync
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    phone character varying(20) NOT NULL,
    email character varying(255),
    nickname character varying(100) DEFAULT ''::character varying,
    avatar_url text DEFAULT ''::text,
    password_hash character varying(255),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    subscription_status character varying(20) DEFAULT 'free'::character varying,
    current_subscription_id uuid,
    phone_encrypted text,
    email_encrypted text,
    tos_accepted_at timestamp without time zone,
    privacy_accepted_at timestamp without time zone,
    marketing_consent boolean DEFAULT false,
    birth_date date,
    age_verified boolean DEFAULT false,
    is_active boolean DEFAULT true,
    deactivated_at timestamp without time zone,
    deactivation_reason text,
    consent_updated_at timestamp without time zone,
    analytics_consent boolean DEFAULT false,
    functional_consent boolean DEFAULT true
);


ALTER TABLE public.users OWNER TO clipsync;

--
-- Name: verification_codes; Type: TABLE; Schema: public; Owner: clipsync
--

CREATE TABLE public.verification_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    phone character varying(20) NOT NULL,
    code character varying(10) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.verification_codes OWNER TO clipsync;

--
-- Data for Name: clipboard_items; Type: TABLE DATA; Schema: public; Owner: clipsync
--

COPY public.clipboard_items (id, user_id, source_device_id, content_type, content_encrypted, content_preview, content_size, metadata, is_favorite, expires_at, created_at, updated_at, search_vector, content_diff) FROM stdin;
\.


--
-- Data for Name: device_sync_state; Type: TABLE DATA; Schema: public; Owner: clipsync
--

COPY public.device_sync_state (id, device_id, last_synced_item_id, last_sync_at) FROM stdin;
\.


--
-- Data for Name: devices; Type: TABLE DATA; Schema: public; Owner: clipsync
--

COPY public.devices (id, user_id, device_name, device_type, platform, platform_version, app_version, public_key, is_online, last_seen_at, created_at) FROM stdin;
\.


--
-- Data for Name: encryption_keys; Type: TABLE DATA; Schema: public; Owner: clipsync
--

COPY public.encryption_keys (id, key_name, key_value, iv, algorithm, is_active, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: file_versions; Type: TABLE DATA; Schema: public; Owner: clipsync
--

COPY public.file_versions (id, clipboard_item_id, user_id, version_number, content_encrypted, content_preview, content_size, metadata, source_device_id, change_description, created_at) FROM stdin;
\.


--
-- Data for Name: invoices; Type: TABLE DATA; Schema: public; Owner: clipsync
--

COPY public.invoices (id, user_id, order_id, invoice_no, amount, tax, status, invoice_url, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: notification_preferences; Type: TABLE DATA; Schema: public; Owner: clipsync
--

COPY public.notification_preferences (id, user_id, notification_type, enabled, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: payment_orders; Type: TABLE DATA; Schema: public; Owner: clipsync
--

COPY public.payment_orders (id, user_id, subscription_id, order_no, amount, currency, payment_method, status, paid_at, transaction_id, metadata, created_at, updated_at, payment_token_encrypted) FROM stdin;
\.


--
-- Data for Name: schema_versions; Type: TABLE DATA; Schema: public; Owner: clipsync
--

COPY public.schema_versions (version, description, applied_at) FROM stdin;
1	Initial schema - users, devices, clipboard_items, device_sync_state, verification_codes	2026-06-24 19:15:24.607084+08
2	Add updated_at column to clipboard_items, add file_versions table	2026-06-24 19:15:24.691089+08
3	Add browser device_type support, add search_vector for full-text search	2026-06-24 19:15:24.96337+08
4	Add content_diff column for incremental sync	2026-06-24 19:15:25.039241+08
5	Add payment & subscription tables (subscription_plans, user_subscriptions, payment_orders, invoices) + extend users table	2026-06-24 19:15:27.619925+08
6	Add encryption fields for sensitive data (phone, email, payment tokens)	2026-06-24 22:20:12.234133+08
7	Add user_sessions table for session management	2026-06-24 23:28:56.741015+08
\.


--
-- Data for Name: subscription_plans; Type: TABLE DATA; Schema: public; Owner: clipsync
--

COPY public.subscription_plans (id, name, price, currency, billing_cycle, max_devices, max_clipboard_items, max_file_size_mb, max_storage_mb, features, is_active, created_at, updated_at) FROM stdin;
7bfe8df3-173d-4023-96d0-32e77314e99c	Free	0.00	CNY	monthly	2	50	1	100	{"ai_classify": true, "offline_queue": true, "e2e_encryption": true, "full_text_search": false, "push_notification": false, "version_history_days": 3}	t	2026-06-24 19:15:26.86267+08	2026-06-24 19:15:26.86267+08
c08c0756-1030-4c50-8c46-220406603d52	Pro	9.90	CNY	monthly	5	999999	20	5120	{"ai_classify": true, "offline_queue": true, "e2e_encryption": true, "full_text_search": true, "push_notification": true, "version_history_days": 30}	t	2026-06-24 19:15:26.901877+08	2026-06-24 19:15:26.901877+08
a7e194a7-f6f2-46a8-878f-be0f3c13e6e6	Enterprise	29.90	CNY	monthly	999999	999999	100	51200	{"ai_classify": true, "team_sharing": true, "offline_queue": true, "e2e_encryption": true, "full_text_search": true, "push_notification": true, "version_history_days": 999999}	t	2026-06-24 19:15:26.929807+08	2026-06-24 19:15:26.929807+08
\.


--
-- Data for Name: user_sessions; Type: TABLE DATA; Schema: public; Owner: clipsync
--

COPY public.user_sessions (id, user_id, device_name, device_type, platform, ip_address, user_agent, jwt_id, is_active, last_active_at, revoked_at, created_at) FROM stdin;
4c8d2da1-09f3-47be-babf-772f0f8e65e2	38682e11-b3fe-4da4-af8e-95c1ea19b85f	Unknown Device	browser	unknown	172.19.0.1	curl/8.19.0	\N	t	2026-06-25 23:55:22.552285+08	\N	2026-06-25 23:55:22.552285+08
\.


--
-- Data for Name: user_subscriptions; Type: TABLE DATA; Schema: public; Owner: clipsync
--

COPY public.user_subscriptions (id, user_id, plan_id, status, current_period_start, current_period_end, cancel_at_period_end, trial_end, created_at, updated_at, subscription_token_encrypted) FROM stdin;
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: clipsync
--

COPY public.users (id, phone, email, nickname, avatar_url, password_hash, created_at, updated_at, subscription_status, current_subscription_id, phone_encrypted, email_encrypted, tos_accepted_at, privacy_accepted_at, marketing_consent, birth_date, age_verified, is_active, deactivated_at, deactivation_reason, consent_updated_at, analytics_consent, functional_consent) FROM stdin;
38682e11-b3fe-4da4-af8e-95c1ea19b85f	13800138000	\N			\N	2026-06-25 23:55:22.503648+08	2026-06-25 23:55:22.503648+08	free	\N	3d3f989ec8bf0ec7b8a06eaa:4c74bdd700d4033e07f55fd1b1a9822d:2476c9e6c61b6b47f6f110	\N	2026-06-25 23:55:22.503648	2026-06-25 23:55:22.503648	f	\N	f	t	\N	\N	\N	f	t
\.


--
-- Data for Name: verification_codes; Type: TABLE DATA; Schema: public; Owner: clipsync
--

COPY public.verification_codes (id, phone, code, expires_at, used, created_at) FROM stdin;
bacbdee9-79b2-43ca-aaa5-ebfc5e5bcd94	13900111111	888888	2026-06-25 10:35:08.04+08	t	2026-06-25 10:25:08.092919+08
6888a68b-198d-4e56-99d5-2a4c28190879	13900222222	888888	2026-06-25 10:35:08.04+08	f	2026-06-25 10:25:08.087106+08
4beb4d9d-07f2-43eb-a9f3-bfb8f5c5200b	13900222222	888888	2026-06-25 10:35:08.04+08	t	2026-06-25 10:25:08.088221+08
a97b68e0-273d-4282-b355-8542a9c56bf6	13800138000	888888	2026-06-25 23:58:05.171+08	f	2026-06-25 23:48:05.187738+08
a87852af-f794-48bb-9958-0659642c2e60	13800138000	888888	2026-06-25 23:58:21.655+08	t	2026-06-25 23:48:21.655816+08
f0c64e1f-87f8-4399-a4d5-aff97da91e73	13800138000	888888	2026-06-26 09:13:18.559+08	f	2026-06-26 09:03:18.681117+08
99feeab8-a7e4-4621-82b7-4e4bdbbf9eb8	13900222222	888888	2026-06-25 15:25:18.983+08	f	2026-06-25 15:15:19.032934+08
7132ecc2-69f2-4efc-b40b-a138fb8c3669	13800138000	888888	2026-06-26 00:05:06.464+08	t	2026-06-25 23:55:06.479534+08
36527aa4-d290-49c8-ae96-fd93dd147987	13800138000	888888	2026-06-26 09:18:38.694+08	f	2026-06-26 09:08:38.695617+08
7a2b97e9-e131-43fc-a4db-f28476e57c71	13900111111	888888	2026-06-25 15:25:18.984+08	t	2026-06-25 15:15:19.037042+08
20c63bc7-102c-433c-875c-e2c7443a44ae	13900222222	888888	2026-06-25 15:25:18.982+08	t	2026-06-25 15:15:19.038632+08
635bef59-e5e4-46ca-a977-bb581936667a	13900222222	888888	2026-06-25 15:34:44.761+08	t	2026-06-25 15:24:44.802059+08
041edbd8-456f-4e4e-9f0f-6b630b36f789	13900222222	888888	2026-06-25 16:17:07.574+08	f	2026-06-25 16:07:07.634356+08
d374cf7d-326a-4173-ba68-36a82b802d18	13900222222	888888	2026-06-25 16:17:07.575+08	t	2026-06-25 16:07:07.634446+08
e2062c21-5e37-4031-87b2-3900e754e651	13900111111	888888	2026-06-25 16:17:07.574+08	t	2026-06-25 16:07:07.638104+08
7e012b55-0c3a-45ea-a395-5f577d4a505d	13900222222	888888	2026-06-25 16:22:53.874+08	t	2026-06-25 16:12:54.004573+08
65ee7b8c-0f58-4041-b26a-d205586cd9e6	13900222222	888888	2026-06-25 16:22:53.876+08	f	2026-06-25 16:12:54.004038+08
39a10005-4859-48a9-85b0-419eec13dd89	13900111111	888888	2026-06-25 16:22:53.875+08	t	2026-06-25 16:12:54.004025+08
e37c87d9-73d7-497c-b289-5aee5138c09d	13800138000	888888	2026-06-25 16:25:28.247+08	t	2026-06-25 16:15:28.366831+08
08881a83-5cb2-4ccb-b01e-5caaa9fc140b	13800138001	888888	2026-06-25 16:25:48.497+08	t	2026-06-25 16:15:48.498017+08
446b934e-87e8-448b-ae71-c37e60cf5017	13800138099	888888	2026-06-25 16:26:55.131506+08	t	2026-06-25 16:16:55.131506+08
2e5f6ecb-cc63-4591-946c-801a8592c8da	13800138100	888888	2026-06-25 16:28:15.793958+08	t	2026-06-25 16:18:15.793958+08
\.


--
-- Name: clipboard_items clipboard_items_pkey; Type: CONSTRAINT; Schema: public; Owner: clipsync
--

ALTER TABLE ONLY public.clipboard_items
    ADD CONSTRAINT clipboard_items_pkey PRIMARY KEY (id);


--
-- Name: device_sync_state device_sync_state_device_id_key; Type: CONSTRAINT; Schema: public; Owner: clipsync
--

ALTER TABLE ONLY public.device_sync_state
    ADD CONSTRAINT device_sync_state_device_id_key UNIQUE (device_id);


--
-- Name: device_sync_state device_sync_state_pkey; Type: CONSTRAINT; Schema: public; Owner: clipsync
--

ALTER TABLE ONLY public.device_sync_state
    ADD CONSTRAINT device_sync_state_pkey PRIMARY KEY (id);


--
-- Name: devices devices_pkey; Type: CONSTRAINT; Schema: public; Owner: clipsync
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_pkey PRIMARY KEY (id);


--
-- Name: devices devices_user_id_device_name_key; Type: CONSTRAINT; Schema: public; Owner: clipsync
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_user_id_device_name_key UNIQUE (user_id, device_name);


--
-- Name: encryption_keys encryption_keys_key_name_key; Type: CONSTRAINT; Schema: public; Owner: clipsync
--

ALTER TABLE ONLY public.encryption_keys
    ADD CONSTRAINT encryption_keys_key_name_key UNIQUE (key_name);


--
-- Name: encryption_keys encryption_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: clipsync
--

ALTER TABLE ONLY public.encryption_keys
    ADD CONSTRAINT encryption_keys_pkey PRIMARY KEY (id);


--
-- Name: file_versions file_versions_clipboard_item_id_version_number_key; Type: CONSTRAINT; Schema: public; Owner: clipsync
--

ALTER TABLE ONLY public.file_versions
    ADD CONSTRAINT file_versions_clipboard_item_id_version_number_key UNIQUE (clipboard_item_id, version_number);


--
-- Name: file_versions file_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: clipsync
--

ALTER TABLE ONLY public.file_versions
    ADD CONSTRAINT file_versions_pkey PRIMARY KEY (id);


--
-- Name: invoices invoices_invoice_no_key; Type: CONSTRAINT; Schema: public; Owner: clipsync
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_invoice_no_key UNIQUE (invoice_no);


--
-- Name: invoices invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: clipsync
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);


--
-- Name: notification_preferences notification_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: clipsync
--

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_pkey PRIMARY KEY (id);


--
-- Name: notification_preferences notification_preferences_user_id_notification_type_key; Type: CONSTRAINT; Schema: public; Owner: clipsync
--

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_user_id_notification_type_key UNIQUE (user_id, notification_type);


--
-- Name: payment_orders payment_orders_order_no_key; Type: CONSTRAINT; Schema: public; Owner: clipsync
--

ALTER TABLE ONLY public.payment_orders
    ADD CONSTRAINT payment_orders_order_no_key UNIQUE (order_no);


--
-- Name: payment_orders payment_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: clipsync
--

ALTER TABLE ONLY public.payment_orders
    ADD CONSTRAINT payment_orders_pkey PRIMARY KEY (id);


--
-- Name: schema_versions schema_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: clipsync
--

ALTER TABLE ONLY public.schema_versions
    ADD CONSTRAINT schema_versions_pkey PRIMARY KEY (version);


--
-- Name: subscription_plans subscription_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: clipsync
--

ALTER TABLE ONLY public.subscription_plans
    ADD CONSTRAINT subscription_plans_pkey PRIMARY KEY (id);


--
-- Name: user_sessions user_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: clipsync
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_pkey PRIMARY KEY (id);


--
-- Name: user_subscriptions user_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: clipsync
--

ALTER TABLE ONLY public.user_subscriptions
    ADD CONSTRAINT user_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: clipsync
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_phone_key; Type: CONSTRAINT; Schema: public; Owner: clipsync
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_phone_key UNIQUE (phone);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: clipsync
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: verification_codes verification_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: clipsync
--

ALTER TABLE ONLY public.verification_codes
    ADD CONSTRAINT verification_codes_pkey PRIMARY KEY (id);


--
-- Name: idx_clipboard_items_content_type; Type: INDEX; Schema: public; Owner: clipsync
--

CREATE INDEX idx_clipboard_items_content_type ON public.clipboard_items USING btree (content_type);


--
-- Name: idx_clipboard_items_created_at; Type: INDEX; Schema: public; Owner: clipsync
--

CREATE INDEX idx_clipboard_items_created_at ON public.clipboard_items USING btree (created_at DESC);


--
-- Name: idx_clipboard_items_favorites; Type: INDEX; Schema: public; Owner: clipsync
--

CREATE INDEX idx_clipboard_items_favorites ON public.clipboard_items USING btree (is_favorite) WHERE (is_favorite = true);


--
-- Name: idx_clipboard_items_user_id; Type: INDEX; Schema: public; Owner: clipsync
--

CREATE INDEX idx_clipboard_items_user_id ON public.clipboard_items USING btree (user_id);


--
-- Name: idx_clipboard_search; Type: INDEX; Schema: public; Owner: clipsync
--

CREATE INDEX idx_clipboard_search ON public.clipboard_items USING gin (search_vector);


--
-- Name: idx_devices_online; Type: INDEX; Schema: public; Owner: clipsync
--

CREATE INDEX idx_devices_online ON public.devices USING btree (is_online) WHERE (is_online = true);


--
-- Name: idx_devices_user_id; Type: INDEX; Schema: public; Owner: clipsync
--

CREATE INDEX idx_devices_user_id ON public.devices USING btree (user_id);


--
-- Name: idx_encryption_keys_active; Type: INDEX; Schema: public; Owner: clipsync
--

CREATE INDEX idx_encryption_keys_active ON public.encryption_keys USING btree (is_active);


--
-- Name: idx_file_versions_item; Type: INDEX; Schema: public; Owner: clipsync
--

CREATE INDEX idx_file_versions_item ON public.file_versions USING btree (clipboard_item_id, version_number);


--
-- Name: idx_file_versions_user; Type: INDEX; Schema: public; Owner: clipsync
--

CREATE INDEX idx_file_versions_user ON public.file_versions USING btree (user_id);


--
-- Name: idx_invoices_invoice_no; Type: INDEX; Schema: public; Owner: clipsync
--

CREATE INDEX idx_invoices_invoice_no ON public.invoices USING btree (invoice_no);


--
-- Name: idx_invoices_user_id; Type: INDEX; Schema: public; Owner: clipsync
--

CREATE INDEX idx_invoices_user_id ON public.invoices USING btree (user_id);


--
-- Name: idx_notification_preferences_user_id; Type: INDEX; Schema: public; Owner: clipsync
--

CREATE INDEX idx_notification_preferences_user_id ON public.notification_preferences USING btree (user_id);


--
-- Name: idx_payment_orders_order_no; Type: INDEX; Schema: public; Owner: clipsync
--

CREATE INDEX idx_payment_orders_order_no ON public.payment_orders USING btree (order_no);


--
-- Name: idx_payment_orders_user_id; Type: INDEX; Schema: public; Owner: clipsync
--

CREATE INDEX idx_payment_orders_user_id ON public.payment_orders USING btree (user_id);


--
-- Name: idx_user_sessions_active; Type: INDEX; Schema: public; Owner: clipsync
--

CREATE INDEX idx_user_sessions_active ON public.user_sessions USING btree (is_active) WHERE (is_active = true);


--
-- Name: idx_user_sessions_is_active; Type: INDEX; Schema: public; Owner: clipsync
--

CREATE INDEX idx_user_sessions_is_active ON public.user_sessions USING btree (is_active);


--
-- Name: idx_user_sessions_user_id; Type: INDEX; Schema: public; Owner: clipsync
--

CREATE INDEX idx_user_sessions_user_id ON public.user_sessions USING btree (user_id);


--
-- Name: idx_user_subscriptions_status; Type: INDEX; Schema: public; Owner: clipsync
--

CREATE INDEX idx_user_subscriptions_status ON public.user_subscriptions USING btree (status);


--
-- Name: idx_user_subscriptions_user_id; Type: INDEX; Schema: public; Owner: clipsync
--

CREATE INDEX idx_user_subscriptions_user_id ON public.user_subscriptions USING btree (user_id);


--
-- Name: idx_verification_codes_phone; Type: INDEX; Schema: public; Owner: clipsync
--

CREATE INDEX idx_verification_codes_phone ON public.verification_codes USING btree (phone, used) WHERE (used = false);


--
-- Name: clipboard_items clipsync_search_vector_update; Type: TRIGGER; Schema: public; Owner: clipsync
--

CREATE TRIGGER clipsync_search_vector_update BEFORE INSERT OR UPDATE OF content_preview, content_type ON public.clipboard_items FOR EACH ROW EXECUTE FUNCTION public.clipsync_update_search_vector();


--
-- Name: clipboard_items clipboard_items_source_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clipsync
--

ALTER TABLE ONLY public.clipboard_items
    ADD CONSTRAINT clipboard_items_source_device_id_fkey FOREIGN KEY (source_device_id) REFERENCES public.devices(id) ON DELETE CASCADE;


--
-- Name: clipboard_items clipboard_items_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clipsync
--

ALTER TABLE ONLY public.clipboard_items
    ADD CONSTRAINT clipboard_items_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: device_sync_state device_sync_state_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clipsync
--

ALTER TABLE ONLY public.device_sync_state
    ADD CONSTRAINT device_sync_state_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;


--
-- Name: devices devices_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clipsync
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: file_versions file_versions_clipboard_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clipsync
--

ALTER TABLE ONLY public.file_versions
    ADD CONSTRAINT file_versions_clipboard_item_id_fkey FOREIGN KEY (clipboard_item_id) REFERENCES public.clipboard_items(id) ON DELETE CASCADE;


--
-- Name: file_versions file_versions_source_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clipsync
--

ALTER TABLE ONLY public.file_versions
    ADD CONSTRAINT file_versions_source_device_id_fkey FOREIGN KEY (source_device_id) REFERENCES public.devices(id) ON DELETE SET NULL;


--
-- Name: file_versions file_versions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clipsync
--

ALTER TABLE ONLY public.file_versions
    ADD CONSTRAINT file_versions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: invoices invoices_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clipsync
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.payment_orders(id) ON DELETE SET NULL;


--
-- Name: invoices invoices_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clipsync
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: payment_orders payment_orders_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clipsync
--

ALTER TABLE ONLY public.payment_orders
    ADD CONSTRAINT payment_orders_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES public.user_subscriptions(id) ON DELETE SET NULL;


--
-- Name: payment_orders payment_orders_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clipsync
--

ALTER TABLE ONLY public.payment_orders
    ADD CONSTRAINT payment_orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_subscriptions user_subscriptions_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clipsync
--

ALTER TABLE ONLY public.user_subscriptions
    ADD CONSTRAINT user_subscriptions_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.subscription_plans(id);


--
-- Name: user_subscriptions user_subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clipsync
--

ALTER TABLE ONLY public.user_subscriptions
    ADD CONSTRAINT user_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: users users_current_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clipsync
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_current_subscription_id_fkey FOREIGN KEY (current_subscription_id) REFERENCES public.user_subscriptions(id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--

\unrestrict nHdN7X3Ue7Qj638T0Gwct07b2ncMPAPY7Wna7MtArrpzZE2nEuPi2h5o6ubmuU5


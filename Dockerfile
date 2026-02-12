# ============================================
# Stage 1: Build
# ============================================
FROM node:20-slim AS builder

# Создаем рабочую директорию
WORKDIR /app

# Копируем файлы зависимостей
COPY package*.json ./

# Устанавливаем все зависимости (включая dev для сборки)
RUN npm ci

# Копируем исходный код
COPY . .

# Собираем TypeScript
RUN npm run build

# ============================================
# Stage 2: Production
# ============================================
FROM node:20-slim AS production

# Устанавливаем системные зависимости для yt-dlp и JS runtime (ffmpeg для постобработки аудио)
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    curl \
    unzip \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Устанавливаем Deno (js runtime для yt-dlp)
ENV DENO_INSTALL=/usr/local
RUN curl -fsSL https://deno.land/x/install/install.sh | sh

# Устанавливаем yt-dlp через pip (последняя стабильная версия)
RUN pip3 install --no-cache-dir --break-system-packages -U yt-dlp

# По умолчанию используем deno, затем node
ENV YT_DLP_JS_RUNTIMES="deno,node"

# Создаем рабочую директорию
WORKDIR /app

# Копируем файлы зависимостей
COPY package*.json ./

# Устанавливаем только production зависимости
RUN npm ci --only=production && npm cache clean --force

# Копируем собранные файлы из build stage
COPY --from=builder /app/dist ./dist

# Открываем порт
EXPOSE 3000

# Запускаем сервер
CMD ["npm", "start"]


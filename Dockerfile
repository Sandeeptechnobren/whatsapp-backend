FROM node:22

# Install Puppeteer necessary dependencies
RUN apt-get update && apt-get install -y \
  wget \
  ca-certificates \
  fonts-liberation \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcups2 \
  libdrm2 \
  libgbm1 \
  libgtk-3-0 \
  libnspr4 \
  libnss3 \
  libx11-xcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  xdg-utils \
  libglib2.0-0 \
  libpango-1.0-0 \
  libxshmfence1 \
  libxss1 \
  --no-install-recommends


# Clean up (optional but saves space)
RUN rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy your app files to the container
COPY . .

# Install node dependencies
RUN npm install

# Expose your app port (if needed)
EXPOSE 8080

# Start your app
CMD ["npm", "start"]

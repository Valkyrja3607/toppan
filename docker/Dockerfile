# ベースイメージ（軽量Python + pip）
FROM python:3.10-slim

# 必要なOSパッケージのインストール（Pillow, OpenSSLなどに必要）
RUN apt-get update && apt-get install -y \
    build-essential \
    libjpeg-dev \
    libpng-dev \
    libopenjp2-7-dev \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# 作業ディレクトリ
WORKDIR /app

# Pythonパッケージリスト（requirements.txtに記載）
COPY requirements.txt .

# パッケージインストール
RUN pip install --no-cache-dir -r requirements.txt

# ポート解放（Streamlit標準）
EXPOSE 8000

# 起動コマンド
# CMD ["streamlit", "run", "app.py", "--server.port=8501", "--server.address=0.0.0.0"]

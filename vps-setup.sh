#!/bin/bash
set -e

echo "=== ChatrixStream VPS Setup (24GB RAM) ==="

# 1. Install FFmpeg with full codec support
echo "[1/8] Installing FFmpeg with full codec support..."
apt update
apt install -y ffmpeg x264 x265 libvpx-dev libopus-dev libfdk-aac-dev libass-dev

echo "FFmpeg version:"
ffmpeg -version | head -3
echo "FFmpeg encoders:"
ffmpeg -encoders 2>/dev/null | grep -E "libx264|aac|copy" | head -5

# 2. Mount 2GB tmpfs for HLS segments (RAM disk - zero disk I/O)
echo "[2/8] Setting up 2GB tmpfs for HLS segments..."
mkdir -p /dev/shm/chatrixstream/hls

# Ensure /dev/shm is large enough (2GB minimum for 24GB VPS)
if ! mountpoint -q /dev/shm; then
    mount -t tmpfs -o size=2G tmpfs /dev/shm
fi

# If /dev/shm is already mounted but too small, remount with 2G
CURRENT_SHM=$(df -BG /dev/shm | tail -1 | awk '{print $2}' | tr -d 'G')
if [ "$CURRENT_SHM" -lt 2 ]; then
    mount -o remount,size=2G /dev/shm
    echo "Remounted /dev/shm to 2GB"
fi

# Make it permanent via fstab
if ! grep -q "tmpfs /dev/shm" /etc/fstab; then
    echo "tmpfs /dev/shm tmpfs defaults,size=2G 0 0" >> /etc/fstab
fi

chmod 777 /dev/shm/chatrixstream/hls
echo "HLS temp: /dev/shm/chatrixstream/hls (2GB RAM disk)"

# 3. System limits and kernel tuning for 24GB RAM
echo "[3/8] Tuning kernel for 24GB RAM..."

cat > /etc/security/limits.d/chatrixstream.conf << 'EOF'
* soft nofile 65536
* hard nofile 65536
root soft nofile 65536
root hard nofile 65536
* soft nproc 65536
* hard nproc 65536
EOF

# Kernel tuning
sysctl -w fs.file-max=2097152
sysctl -w fs.nr_open=1048576
sysctl -w vm.swappiness=1
sysctl -w vm.dirty_ratio=15
sysctl -w vm.dirty_background_ratio=5
sysctl -w vm.dirty_expire_centisecs=3000
sysctl -w vm.dirty_writeback_centisecs=500

# Network buffer tuning (large for stream ingestion at high bitrate)
sysctl -w net.core.rmem_max=33554432
sysctl -w net.core.wmem_max=33554432
sysctl -w net.core.rmem_default=524288
sysctl -w net.core.wmem_default=524288
sysctl -w net.core.netdev_max_backlog=10000
sysctl -w net.core.somaxconn=4096
sysctl -w net.ipv4.tcp_rmem="4096 131072 33554432"
sysctl -w net.ipv4.tcp_wmem="4096 65536 33554432"
sysctl -w net.ipv4.tcp_max_syn_backlog=8192
sysctl -w net.ipv4.tcp_tw_reuse=1
sysctl -w net.ipv4.tcp_fin_timeout=15
sysctl -w net.ipv4.tcp_keepalive_time=300
sysctl -w net.ipv4.tcp_keepalive_intvl=30
sysctl -w net.ipv4.tcp_keepalive_probes=5
sysctl -w net.ipv4.tcp_max_tw_buckets=5000
sysctl -w net.ipv4.tcp_fastopen=3
sysctl -w net.ipv4.ip_local_port_range="1024 65535"
sysctl -w net.ipv4.tcp_moderate_rcvbuf=1
sysctl -w net.ipv4.tcp_adv_win_scale=1

# Save sysctl permanently
cat > /etc/sysctl.d/99-chatrixstream.conf << 'SYSCTL'
fs.file-max=2097152
fs.nr_open=1048576
vm.swappiness=1
vm.dirty_ratio=15
vm.dirty_background_ratio=5
vm.dirty_expire_centisecs=3000
vm.dirty_writeback_centisecs=500
net.core.rmem_max=33554432
net.core.wmem_max=33554432
net.core.rmem_default=524288
net.core.wmem_default=524288
net.core.netdev_max_backlog=10000
net.core.somaxconn=4096
net.ipv4.tcp_rmem=4096 131072 33554432
net.ipv4.tcp_wmem=4096 65536 33554432
net.ipv4.tcp_max_syn_backlog=8192
net.ipv4.tcp_tw_reuse=1
net.ipv4.tcp_fin_timeout=15
net.ipv4.tcp_keepalive_time=300
net.ipv4.tcp_keepalive_intvl=30
net.ipv4.tcp_keepalive_probes=5
net.ipv4.tcp_max_tw_buckets=5000
net.ipv4.tcp_fastopen=3
net.ipv4.ip_local_port_range=1024 65535
net.ipv4.tcp_moderate_rcvbuf=1
net.ipv4.tcp_adv_win_scale=1
SYSCTL

sysctl --system > /dev/null 2>&1 || true

# 4. Stop MediaMTX (no longer needed)
echo "[4/8] Removing MediaMTX..."
systemctl stop mediamtx 2>/dev/null || true
systemctl disable mediamtx 2>/dev/null || true
pm2 stop mediamtx 2>/dev/null || true
pm2 delete mediamtx 2>/dev/null || true
rm -f /usr/local/bin/mediamtx 2>/dev/null || true
rm -rf /etc/mediamtx 2>/dev/null || true
rm -f /var/www/ChatrixStream/mediamtx.yml 2>/dev/null || true

# 5. Install Node.js dependencies
echo "[5/8] Installing dependencies..."
cd /var/www/ChatrixStream
npm install

# 6. Create directories
echo "[6/8] Creating directories..."
mkdir -p tmp/hls logs db

# 7. Start with PM2
echo "[7/8] Starting PM2..."
pm2 stop chatrixstream 2>/dev/null || true
pm2 delete chatrixstream 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u root --hp /root 2>/dev/null || true

# 8. Final status
echo "[8/8] Status..."
echo ""
echo "=== VPS Resources ==="
echo "CPU cores: $(nproc)"
echo "RAM: $(free -h | grep Mem | awk '{print $2}') total, $(free -h | grep Mem | awk '{print $7}') available"
echo "/dev/shm: $(df -h /dev/shm | tail -1 | awk '{print $2}')"
echo ""
echo "=== PM2 ==="
pm2 status
echo ""
echo "=== FFmpeg Capabilities ==="
ffmpeg -encoders 2>/dev/null | grep -E "264|265|aac|copy" | head -10
echo ""
echo "=== CONFIG SUMMARY (24GB RAM) ==="
echo "Node.js heap: 8GB max"
echo "HLS temp: 2GB RAM disk (/dev/shm)"
echo "Stream buffer: 8MB highWaterMark"
echo "Pipe rolling buffer: 4MB"
echo "Segment LRU cache: 20 segments"
echo "FFmpeg threads: auto (all cores)"
echo "Network recv buffer: 32MB max"
echo "Idle timeout: 60s"
echo ""
echo "Monitor: pm2 monit"
echo "Logs: pm2 logs chatrixstream"

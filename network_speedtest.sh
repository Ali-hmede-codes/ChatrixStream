#!/bin/bash

echo "======================================"
echo "    VPS Network Speed Test Script     "
echo "======================================"
echo ""

# Check if python is available
if ! command -v python3 &> /dev/null && ! command -v python &> /dev/null; then
    echo "Python is not installed. Falling back to basic curl test..."
    echo "Downloading 100MB test file to measure speed..."
    # Convert bytes/sec to Megabytes/sec
    curl -o /dev/null -w "Average Download Speed: %{speed_download} bytes/sec\n" http://speedtest.tele2.net/100MB.zip
    exit 0
fi

echo "Fetching speedtest-cli..."
curl -sLo /tmp/speedtest-cli https://raw.githubusercontent.com/sivel/speedtest-cli/master/speedtest.py
chmod +x /tmp/speedtest-cli

echo "Running Speedtest (this may take a minute)..."
/tmp/speedtest-cli --simple

# Clean up
rm /tmp/speedtest-cli

echo ""
echo "Test completed."

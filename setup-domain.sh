#!/bin/bash
set -e

echo "Setting up Railway domain for the web service..."
# Ensure the user is logged in
railway whoami || railway login

# Link the project (assumes you are in the linked directory or will be prompted)
railway link

# Add a custom domain to the web service
echo "Enter your custom domain (e.g., roastmebobo.com):"
read DOMAIN

railway domain add $DOMAIN --service web

echo "Domain $DOMAIN has been attached to the web service."

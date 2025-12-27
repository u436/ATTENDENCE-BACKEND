const express = require('express');
const router = express.Router();
const webpush = require('web-push');
const schedule = require('node-schedule');
const fs = require('fs');
const path = require('path');

// VAPID keys for push notifications
const VAPID_PUBLIC_KEY = 'BKqSt3U5CMpk9zhxpw_o16OnbjDCY1VZQ0iXVoutufMN8HxkGwS6pbVNOkJAmS57kvML_H80RHN7pUfvkp47HMI';
const VAPID_PRIVATE_KEY = '6CD9Bk0pa__Nh6unDH7Ab9_8VbDpiVOR7vjmoJi5ARQ';

// Configure web-push
webpush.setVapidDetails(
  'mailto:attendance-tracker@example.com',
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

// File to store subscriptions
const SUBSCRIPTIONS_FILE = path.join(__dirname, '../../subscriptions.json');

// Load subscriptions from file
function loadSubscriptions() {
  try {
    if (fs.existsSync(SUBSCRIPTIONS_FILE)) {
      const data = fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error loading subscriptions:', error);
  }
  return {};
}

// Save subscriptions to file
function saveSubscriptions(subscriptions) {
  try {
    fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(subscriptions, null, 2));
  } catch (error) {
    console.error('Error saving subscriptions:', error);
  }
}

// Store subscriptions in memory (loaded from file)
let subscriptions = loadSubscriptions();

// Track scheduled jobs
const scheduledJobs = {};

// Get VAPID public key
router.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// Subscribe to push notifications
router.post('/subscribe', (req, res) => {
  const { subscription, notificationTime, userId } = req.body;
  
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }

  const userKey = userId || subscription.endpoint;
  
  // Store the subscription with notification time
  subscriptions[userKey] = {
    subscription,
    notificationTime: notificationTime || '09:00',
    createdAt: new Date().toISOString()
  };
  
  saveSubscriptions(subscriptions);
  
  // Schedule notification for this user
  scheduleUserNotification(userKey);
  
  console.log(`✅ New subscription saved. Time: ${notificationTime}. Total subscriptions: ${Object.keys(subscriptions).length}`);
  
  res.json({ success: true, message: 'Subscription saved' });
});

// Update notification time
router.post('/update-time', (req, res) => {
  const { userId, notificationTime } = req.body;
  
  if (!userId || !notificationTime) {
    return res.status(400).json({ error: 'Missing userId or notificationTime' });
  }
  
  if (subscriptions[userId]) {
    subscriptions[userId].notificationTime = notificationTime;
    saveSubscriptions(subscriptions);
    
    // Reschedule notification
    scheduleUserNotification(userId);
    
    console.log(`🔄 Updated notification time for user to ${notificationTime}`);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Subscription not found' });
  }
});

// Unsubscribe from push notifications
router.post('/unsubscribe', (req, res) => {
  const { userId } = req.body;
  
  if (subscriptions[userId]) {
    delete subscriptions[userId];
    saveSubscriptions(subscriptions);
    
    // Cancel scheduled job
    if (scheduledJobs[userId]) {
      scheduledJobs[userId].cancel();
      delete scheduledJobs[userId];
    }
    
    console.log(`❌ User unsubscribed`);
  }
  
  res.json({ success: true });
});

// Send push notification to a specific subscription
async function sendPushNotification(userKey) {
  const userData = subscriptions[userKey];
  if (!userData || !userData.subscription) {
    console.log(`⚠️ No subscription found for user`);
    return;
  }
  
  const payload = JSON.stringify({
    title: '📚 Attendance Tracker',
    body: 'Time to mark your attendance for today!',
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    data: {
      url: '/',
      timestamp: Date.now()
    }
  });
  
  try {
    await webpush.sendNotification(userData.subscription, payload);
    console.log(`✅ Push notification sent successfully at ${new Date().toLocaleTimeString()}`);
  } catch (error) {
    console.error('❌ Error sending push notification:', error);
    
    // Remove invalid subscriptions (e.g., user revoked permission)
    if (error.statusCode === 410 || error.statusCode === 404) {
      console.log('🗑️ Removing invalid subscription');
      delete subscriptions[userKey];
      saveSubscriptions(subscriptions);
      
      if (scheduledJobs[userKey]) {
        scheduledJobs[userKey].cancel();
        delete scheduledJobs[userKey];
      }
    }
  }
}

// Schedule notification for a user
function scheduleUserNotification(userKey) {
  const userData = subscriptions[userKey];
  if (!userData) return;
  
  // Cancel existing job if any
  if (scheduledJobs[userKey]) {
    scheduledJobs[userKey].cancel();
  }
  
  const [hours, minutes] = userData.notificationTime.split(':').map(Number);
  
  // Create a cron-style schedule: run every day at the specified time
  const cronExpression = `${minutes} ${hours} * * *`;
  
  scheduledJobs[userKey] = schedule.scheduleJob(cronExpression, () => {
    console.log(`⏰ Scheduled notification triggered for user at ${userData.notificationTime}`);
    sendPushNotification(userKey);
  });
  
  console.log(`📅 Scheduled daily notification at ${userData.notificationTime} (cron: ${cronExpression})`);
}

// Test endpoint to send a notification immediately
router.post('/test', async (req, res) => {
  const { userId } = req.body;
  
  if (!userId || !subscriptions[userId]) {
    return res.status(404).json({ error: 'Subscription not found' });
  }
  
  await sendPushNotification(userId);
  res.json({ success: true, message: 'Test notification sent' });
});

// Initialize: Schedule notifications for all existing subscriptions
function initializeScheduledJobs() {
  console.log(`🚀 Initializing scheduled jobs for ${Object.keys(subscriptions).length} subscriptions...`);
  
  for (const userKey of Object.keys(subscriptions)) {
    scheduleUserNotification(userKey);
  }
}

// Run initialization
initializeScheduledJobs();

module.exports = router;

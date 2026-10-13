# Jarvis privacy policy

_Last updated: [date you publish]. Contact: [your business email]._

Jarvis is a voice assistant for delivery drivers. This policy explains what the app does with your information.
There are no ads and no accounts, and we never sell your data.

## Your voice
- Jarvis listens for "Hey Jarvis" **on your phone**. Until he hears it, no audio leaves the phone.
- After "Hey Jarvis", the words you say are sent to **Groq** (groq.com) to be turned into text and answered. In the version
  without a personal key, they pass through our service on **Cloudflare**, which adds our Groq key and forwards them. Neither
  the app nor our service keeps a copy of your audio or your questions.
- Jarvis's spoken replies are generated on your phone.

## Your location
- When you use navigation, deliveries, weather or "where am I", your location is used on the phone and sent to the map and
  weather services that answer the request: OpenStreetMap services (Nominatim, OSRM, Valhalla), Photon and Open-Meteo.
  If you choose Google Maps or Apple Maps in Settings, it is sent to them instead. We don't store your location.

## Delivery offers (offer reader, only if you turn it on)
- If you switch on the offer reader, Jarvis reads the text of delivery offers shown by the DoorDash Dasher and Uber Driver
  apps (and no other apps) so he can tell you whether an offer meets your pay floors. This happens on your phone. What he reads
  is not saved or sent anywhere. Only if you then ask Jarvis about the offer is a short summary sent to Groq as part of your question.
- Jarvis never taps, accepts or declines anything in those apps.

## Camera and screen (only when you ask)
- When you ask Jarvis what he sees ("what is this?", "read this sign"), he takes one picture with your camera, shows you a preview,
  and sends that picture to **Groq** (through our service on **Cloudflare** in the version without a personal key) to describe it.
  "Take a photo" saves the picture to your gallery and sends nothing.
- When you ask about your screen ("what's on my screen?") and have switched on **Jarvis phone control**, he takes one screenshot and
  sends it the same way. Nothing is kept by the app or our service.

## Phone control (only if you switch it on)
- "Jarvis phone control" is an Android accessibility service you switch on yourself. When you ask Jarvis to do something in another app,
  it reads the text on the screen and taps, types, scrolls or presses Back / Home for you. It acts only on your requests, never types
  passwords, and never operates the DoorDash Dasher, Uber Driver or Grubhub Driver apps. The screen text it reads is sent to Groq only
  as part of carrying out your request, and is not stored.

## Contacts, calls, messages and calendar (each asked for the first time you use it)
- **Contacts:** to call or text someone by name, Jarvis looks the name up on your phone. Your contact list is never uploaded; only the
  name you said is part of your question.
- **Calls:** with permission, Jarvis places the call you asked for; otherwise he opens the dialer.
- **Notifications (only if you give notification access):** to read your messages out loud and reply through the notification's Reply
  button. Kept in memory on the phone only; a message is sent to Groq only when you ask Jarvis about it.
- **Calendar:** to tell you what's on and add events you ask for. Events stay in your calendar; what Jarvis reads out is part of your question.
- **Clipboard:** read only when you ask ("what did I copy?").

## Live interpreter (only while it's on)
What you and the other person say is sent to Groq to be written down and translated, the same way as any question to Jarvis. Nothing is kept.

## Driving, safety and expenses (only when you use them)
- **Shifts and mileage:** while a shift is on, your phone's GPS adds up the miles. Only the totals per shift (date, times, miles) are kept, on your phone.
- **Parking:** the spot you saved is kept on your phone until you save another.
- **SOS:** when you say "emergency", Jarvis texts your location (a map link) to the emergency contacts you chose, from your own phone number, every 5 minutes until you say "I'm safe". Only those people receive it.
- **Receipts:** a receipt photo is sent to Groq to read the store, date and total; only those details are kept, on your phone.
- **Nearby gas:** your approximate position is sent to OpenStreetMap's Overpass service to find stations.
- **Weather alerts:** your approximate position is sent to the US National Weather Service (or Open-Meteo outside the US).

## Smart home (only if you connect one)
Jarvis talks directly to your Home Assistant or Philips Hue bridge with the address and token you enter. They stay on your phone and are not sent to us.

## Reminders, alarms and documents
Reminders and timers are stored on your phone and ring through Android's alarm system. Wake-up alarms go to your Clock app. Documents
Jarvis writes for you are saved in your phone's Documents/Jarvis folder.

## Stored on your phone only
Your settings, saved places, orders and earnings log, notes, reminders and timers, documents and photos he saved for you, things you asked Jarvis to remember, and the last
few messages of your conversation. Say "forget everything", or clear the app's data in Android Settings, to delete them.

## Other services Jarvis may contact when you ask
Web search (DuckDuckGo, Wikipedia), news (BBC RSS), crypto prices (CoinGecko), exchange rates (open.er-api.com), and GitHub
(one-time download of Jarvis's voices). These receive your request and your phone's network address, as any website would.

## Identifiers
The app creates a random ID so our service can limit how many requests one phone makes. It isn't linked to your name,
phone number or accounts.

## Children
Jarvis is meant for adults and isn't directed at children under 13.

## Changes
If this policy changes, the new version will be posted at this address with a new date.

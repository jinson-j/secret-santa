const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const bcrypt = require("bcrypt");
const dotenv = require("dotenv");
const fs = require("fs");
const nodemailer = require("nodemailer");
const {MongoClient, ServerApiVersion, ObjectId} = require("mongodb");
const {google} = require("googleapis");

const app = express();
dotenv.config();

const portNumber = 5000;
const targetDate = "2024-12-15T18:00:00-05:00"; // 15th December 2024 @ 6:00 PM EST
// const targetDate = new Date(Date.now() + 2 * 60 * 1000).toISOString(); // 2 minutes after running (for video :P)

app.set("view engine", "ejs");
app.set("views", __dirname + "/templates");
app.use(express.static("public"));
app.use(bodyParser.urlencoded({extended:false}));
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {secure: false}
}));

// ============= Google Calendar API =============

const SCOPES = ["https://www.googleapis.com/auth/calendar"];
const TOKEN_PATH = "token.json";
let oAuth2Client;

// load credentials 
function loadCredentials() {
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS || {});
    oAuth2Client = new google.auth.OAuth2(
        credentials.web.client_id,
        credentials.web.client_secret,
        credentials.web.redirect_uris[0]
    );

    // new token if nothing is stored
    fs.readFile(TOKEN_PATH, (err, token) => {
        if (err) {
            getNewToken(oAuth2Client);
        } else {
            oAuth2Client.setCredentials(JSON.parse(token));
        }
    });
}

// oAuth 
function getNewToken(oAuth2Client) {
    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: "offline",
        scope: SCOPES,
    });
    console.log("Url:", authUrl);
}

// used to get the token from the URL should store token properly
app.get("/oauth2callback", (req, res) => {
    const code = req.query.code; 
    if (!code) {
        return res.send("No code received");
    }

    oAuth2Client.getToken(code, (err, token) => {
        if (err) {
            console.log("Error while getting the token", err);
            return res.send("Error while getting the token");
        }
        
        oAuth2Client.setCredentials(token);
        fs.writeFile(TOKEN_PATH, JSON.stringify(token), (err) => {
            if (err) {
                console.log("Error saving the token", err);
                return res.send("Error saving the token");
            }
            console.log("Token path: ", TOKEN_PATH);
            res.send("OAuth2 callback processed");
        });
    });
});

// ============= MongoDB =============

const uri = `mongodb+srv://${process.env.MONGO_DB_USERNAME}:${process.env.MONGO_DB_PASSWORD}@cluster0.u5oqo.mongodb.net/${process.env.MONGO_DB_NAME}?retryWrites=true&w=majority&appName=Cluster0`;
const client = new MongoClient(uri, {serverApi: ServerApiVersion.v1});

let users;
async function initializeDB() {
    await client.connect();
    users = client.db(process.env.MONGO_DB_NAME).collection(process.env.MONGO_COLLECTION);
}

// ============ Server ============

process.stdin.setEncoding("utf8"); 
process.stdin.on("readable", () => {     
    const dataInput = process.stdin.read();
    if (dataInput !== null) {
        const command = dataInput.trim();
        if (command === "stop") {
            process.stdout.write("Shutting down the server\n");
            process.exit(0);  
        } else if (command === "override-pair") {
            pair();
            process.stdout.write("Pairing completed\n");
        } else if (command == "add-random") {
            insertRandomEntries();
            process.stdout.write("Added random users\n")
        } else {
            process.stdout.write(`Invalid command: ${command}\n`);
        }
    }
    process.stdin.resume();
});

app.listen(portNumber, () => {
    process.stdout.write(`Web server started and running at http://localhost:${portNumber}/\n`);
    process.stdout.write("Usage:\nstop -> shutdown the server\n" +
                        "override-pair -> pair ahead of schedule\n" + 
                        "add-random -> add random users\n");
});

// ============ NodeMailer ============

const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_ADDRESS,
      pass: process.env.EMAIL_PASSWORD, // this is an app password!
    }
});

// ============ Routes/Endpoints ============

app.get("/", (req, res) => {
    res.render("login");
});

app.get("/login", (req, res) => {
    res.render("login");
});

app.post("/login", async (req, res) => {
    const {username, password} = req.body;
    const user = await users.findOne({username});

    if (user && await bcrypt.compare(password, user.password)) {
        req.session.userId = user._id;
        res.render("secret_santa");
    } else {
        res.render("login", {error: "Invalid username or password!"});
    }
});

app.get("/register", (req, res) => {
    res.render("register");
});

app.post("/register", async (req, res) => {
    const {username, email, password, confirmPassword} = req.body;
    if (password !== confirmPassword) {
        return res.render("register", {error: "Passwords do not match!"});
    }

    const existingEmail = await users.findOne({email});
    const existingUser = await users.findOne({username});
    if (existingEmail || existingUser) {
        return res.render("register", {error: "User already exists!"});
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await users.insertOne({username, email, password: hashedPassword, gift: null, recipient: null});
    return res.render("register", {error: "You can log in now!"});
});

app.get("/secret_santa", (req, res) => {
    if (!req.session.userId) {
        return res.render("register", {error: "Please login first!"});
    }
    res.render("secret_santa");
});

app.post("/secret_santa", async (req, res) => {
    if (!req.session.userId) {
        return res.render("register", {error: "Please login first!"});
    }

    const {name, email, gift} = req.body;
    const user = await users.findOne({_id: ObjectId.createFromHexString(req.session.userId)});
    if (user.username === name && user.email === email) {
        await users.updateOne({_id: ObjectId.createFromHexString(req.session.userId)}, {$set: {gift: gift}});
        if (!user.gift) { // i am a genius (will not send email more than once)
            // do g-cal processing now
            await createGoogleCalendarEventForUser(user);
        }
        return res.render("success");
    } else {
        return res.render("secret_santa", {error: "Username and Email didn't match!"});
    }
});

// =============== Logic ===============

// https://www.geeksforgeeks.org/shuffle-a-given-array-using-fisher-yates-shuffle-algorithm/ 
async function pair() {
    let participants = await users.find({gift: {$ne: null}}).toArray();
    if (participants.length < 2) {
        return;
    }

    for (let i = participants.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [participants[i], participants[j]] = [participants[j], participants[i]];
    }

    for (let i = 0; i < participants.length; i++) {
        const santa = participants[i];
        const recipient = participants[(i + 1) % participants.length];
        await users.updateOne({_id: santa._id}, {$set: {recipient: recipient.username}});

        const mailOptions = {
            from: process.env.EMAIL_ADDRESS,
            to: santa.email,                // change to santa.email when running fo-real! (can use temp email for testing)
            subject: "Secret Santa Event",  //  ^ all mail should go to proper recipient 
            text: `HO HO HO! Drumroll please!... \nYou (${santa.username}) are the Secret Santa for ${recipient.username}! \nThey requested: \n${recipient.gift} \nRemember to spend between $20 and $30!`,
        };
        async function sendEmail() {
            transporter.sendMail(mailOptions, function(error, info){
                if (error) {
                    console.log("Mail failed to send! Retrying...");
                    sendEmail(); // seems to fail too much so loop it
                } else {
                    console.log(`Email sent: ${info.response}`);
                }
            });
        }
        await sendEmail();
    }
}

// random entries for testing purposes the emails hopefully aren't real?
async function insertRandomEntries() {
    const randomEntries = [];
    for (let i = 0; i < 20; i++) {
        const username = `user${Math.random().toString(36).substring(2, 8)}`;
        const email = `${username}@mail.com`; // -> these are real emails btw
        const password = await bcrypt.hash(`pass`, 10);
        const gift = `gift${Math.random().toString(36).substring(2, 8)}`;

        randomEntries.push({
            username,
            email,
            password,
            gift,
            recipient: null
        });
    }

    const result = await users.insertMany(randomEntries);
    console.log(`${result.insertedCount} documents were inserted.`);
}

// i may make it so that the event isn't hard coded, but if it isn't ¯\_(ツ)_/¯
async function createGoogleCalendarEventForUser(user) {
    const calendar = google.calendar({ version: "v3", auth: oAuth2Client });
    calendar.events.insert({
        calendarId: "primary",
        resource: {
            summary: "Secret Santa Party",
            location: "123 Elf Road, North Pole, 88888",
            description: "Secret Santa event to exchange gifts!",
            start: {
                dateTime: "2024-12-25T18:00:00-05:00",
                timeZone: "America/New_York",
            },
            end: {
                dateTime: "2024-12-25T22:00:00-05:00",
                timeZone: "America/New_York",
            },
            attendees: [{email: user.email}],  
            reminders: {
                useDefault: true, // >:(
            },
            sendUpdates: "all", // bro these do nothing so I use nodemailer
        },
    }, async (err, event) => {
        if (err) {
            console.log(`Error creating event: ${err}`);
            return;
        }
        const mailOptions = {
            from: process.env.EMAIL_ADDRESS,
            to: user.email,
            subject: "Secret Santa Event",
            text: `HO HO HO! Thank you for registering! \nYou can find your Google Calendar event here: \n${event.data.htmlLink}! \nYou can also find more info in the Discord: https://discord.gg/Zw7dTutn`,
        };   
        async function sendEmail() {
            transporter.sendMail(mailOptions, function(error, info){
            if (error) {
                console.log("Mail failed to send! Retrying...");
                sendEmail(); // retry sending email
            } else {
                console.log(`Email sent: ${info.response}`);
            }
            });
        }
        await sendEmail();
        console.log(`Event created: ${event.data.htmlLink}`);
    });
}

async function schedulePairing(targetDate) {
    const now = new Date();
    const target = new Date(targetDate);

    const timeDifference = target - now;
    timeUntilTarget = timeDifference > 0 ? timeDifference : 0; 
    // timeUntilTarget = 1000; // testing purposes, comment out fo-real (100s)

    console.log(`Scheduling pairing for ${targetDate}`);
    console.log(`Time until pairing: ${timeUntilTarget / 1000} seconds`);

    setTimeout(async () => {
        console.log("Pairing started!");
        await pair();
        console.log("Pairing completed!");
    }, timeUntilTarget);
}

// ============ Running ============

// set up Google OAuth
// |
// V
// set up MongoDB
// | 
// V
// schedule pairing

loadCredentials();
initializeDB();
schedulePairing(targetDate);
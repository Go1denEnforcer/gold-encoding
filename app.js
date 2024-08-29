const express = require('express');
const multer = require('multer');
const path = require('path');
const session = require('express-session');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(ffmpegPath);

const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;

// Connect to SQLite database
const db = new sqlite3.Database('./video_metadata.db', (err) => {
    if (err) {
        console.error("Error opening database:", err.message);
    } else {
        console.log("Connected to the SQLite database.");
    }
});

// In-memory store for users' uploaded files
const userFiles = {};

// Create a table for storing video metadata
db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL)");
    db.run("CREATE TABLE IF NOT EXISTS videos (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, original_filename TEXT, thumbnail TEXT, path_720p TEXT, path_480p TEXT, path_360p TEXT, upload_date DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (user_id) REFERENCES users(id))");
});

app.use(session({
    secret: 'your-secret-key',
    resave: false,
    saveUninitialized: true
}));

app.use(express.urlencoded({ extended: true }));

// Set EJS as the template engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve static files from 'views' for CSS/JS and 'uploads' for files
app.use(express.static(path.join(__dirname, 'views')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Set up storage engine for file uploads
const storage = multer.diskStorage({
    destination: './uploads/',
    filename: function (req, file, cb) {
        cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname));
    }
});

// Init upload middleware
const upload = multer({
    storage: storage,
    limits: { fileSize: 100000000 }, // Limit file size to 100MB
    fileFilter: function (req, file, cb) {
        checkFileType(file, cb);
    }
}).single('video');

// Check file type function
function checkFileType(file, cb) {
    const filetypes = /mp4|mov|avi|mkv/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = filetypes.test(file.mimetype);
    if (mimetype && extname) {
        return cb(null, true);
    } else {
        cb('Error: Videos Only!');
    }
}

// Transcode video function
function transcodeVideo(inputPath, outputPath, resolution) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .output(outputPath)
            .videoCodec('libx264')
            .size(resolution)
            .on('end', () => {
                console.log(`File has been transcoded to ${resolution}`);
                resolve();
            })
            .on('error', (err) => {
                console.error(`Error transcoding file: ${err.message}`);
                reject(err);
            })
            .run();
    });
}

// Function to show a video thumbnail
function generateThumbnail(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .screenshots({
                count: 1,
                folder: path.dirname(outputPath),
                filename: path.basename(outputPath),
                size: '320x240'
            })
            .on('end', () => {
                console.log(`Thumbnail created at ${outputPath}`);
                resolve();
            })
            .on('error', (err) => {
                console.error(`Error generating thumbnail: ${err.message}`);
                reject(err);
            });
    });
}

// Middleware to check if the user is authenticated
function isAuthenticated(req, res, next) {
    if (req.session.loggedIn) {
        return next();
    } else {
        res.redirect('/');
    }
}

// Display the login page
app.get('/', (req, res) => {
    const error = req.query.error === '1';
    res.render('index', { error });
});

// Handle login
app.post('/login', (req, res) => {
    const { username, password } = req.body;

    db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Internal Server Error');
        }

        if (user && user.password === password) {
            req.session.loggedIn = true;
            req.session.username = user.username;
            res.redirect('/files');
        } else {
            res.redirect('/?error=1'); // Redirect to login page with error
        }
    });
});

// Display the upload page
app.get('/upload', isAuthenticated, (req, res) => {
    res.render('upload', {errorMessage: null, successMessage: null });
});

// Handle file upload and transcoding
app.post('/upload', isAuthenticated, (req, res) => {
    upload(req, res, async (err) => {
        if (err) {
            res.render('upload', { errorMessage: err.message || 'An error occurred.', successMessage: null });
        } else {
            if (req.file == undefined) {
                res.render('upload', { errorMessage: 'No file selected!', successMessage: null });
            } else {
                const inputPath = path.join(__dirname, req.file.path);
                const outputPaths = [
                    { path: path.join(__dirname, 'uploads', `720p-${req.file.filename}`), resolution: '1280x720' },
                    { path: path.join(__dirname, 'uploads', `480p-${req.file.filename}`), resolution: '854x480' },
                    { path: path.join(__dirname, 'uploads', `360p-${req.file.filename}`), resolution: '640x360' },
                ];
                const thumbnailPath = path.join(__dirname, 'uploads', `thumbnail-${req.file.filename}.png`);

                try {
                    await Promise.all(outputPaths.map(output => transcodeVideo(inputPath, output.path, output.resolution)));
                    await generateThumbnail(inputPath, thumbnailPath);

                    // Store file information in the database
                    const username = req.session.username;
                    db.get("SELECT id FROM users WHERE username = ?", [username], (err, row) => {
                        if (row) {
                            db.run("INSERT INTO videos (user_id, original_filename, thumbnail, path_720p, path_480p, path_360p) VALUES (?, ?, ?, ?, ?, ?)", [row.id, req.file.filename, thumbnailPath, outputPaths[0].path, outputPaths[1].path, outputPaths[2].path]);
                        }
                    });

                    res.render('upload', { errorMessage: null, successMessage: 'File uploaded and transcoded successfully!' });
                } catch (transcodeError) {
                    res.render('upload', { errorMessage: 'Error transcoding video.', successMessage: null });
                }
            }
        }
    });
});




// Route to display the list of uploaded files
app.get('/files', isAuthenticated, (req, res) => {
    const username = req.session.username;
    db.get("SELECT id FROM users WHERE username = ?", [username], (err, userRow) => {
        if (userRow) {
            db.all("SELECT * FROM videos WHERE user_id = ?", [userRow.id], (err, rows) => {
                const files = rows.map(row => ({
                    original: row.original_filename,
                    transcodedFiles: [
                        `/uploads/${path.basename(row.path_720p)}`,
                        `/uploads/${path.basename(row.path_480p)}`,
                        `/uploads/${path.basename(row.path_360p)}`
                    ],
                    thumbnail: `/uploads/${path.basename(row.thumbnail)}`
                }));
                res.render('files', { files, downloadSuccess: '' });
            });
        } else {
            res.render('files', { files: [], downloadSuccess: '' });
        }
    });
});



// Route to download the video file
app.get('/download/:filename', isAuthenticated, (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(__dirname, 'uploads', filename);

    res.download(filePath, (err) => {
        if (err) {
            console.error(`Error downloading file: ${err}`);
            res.status(404).send('File not found.');
        } else {
            // Redirect back to the files page with a success message
            res.redirect('/files?downloadSuccess=1');
        }
    });
});

// Logout route
app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            return res.status(500).send('Error logging out.');
        }
        res.redirect('/');
    });
});

app.listen(PORT, () => console.log(`Server started on port ${PORT}`));

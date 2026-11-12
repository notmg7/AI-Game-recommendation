# 🎮 Game Discovery Engine

**An explainable, AI-powered game recommendation platform that learns your "Gamer DNA" and tells you *why* it recommends each game.**

Final year project, BSc (Hons) Computer Science, University of West London (2026)

![Discovery Hub](images/discovery-hub.png)

---

## 📌 The Problem

Digital game stores offer so many titles that players end up with decision fatigue instead of good choices. Existing discovery tools rely on static genre filters and popularity rankings, which bury niche games and never explain their suggestions.

## 💡 The Solution

The Game Discovery Engine builds a personal **Gamer DNA profile** from how you actually play: the games you favourite, like, wishlist, play and finish, and how many hours you log. A **Support Vector Machine (RBF kernel)** then ranks games against that profile and shows each one with a transparent **Match Score**.

---

## ✨ Key Features

- **Discovery Hub:** AI-ranked recommendations with Platt-calibrated Match Score badges (0–100%).
- **Gamer DNA profile:** built from 5 library categories (Favorites, Liked, Playing, Wishlist, Played), with logged playtime acting as a continuous weight.
- **DNA Blade:** a radar chart showing which genres and themes drive your recommendations, with sliders to adjust them manually.
- **Real-time updates:** every library change re-ranks recommendations instantly through Firestore listeners, with no page refresh.
- **Playtime transparency:** "Time-to-Beat" estimates (Hastily / Normally / Completely) shown alongside every Match Score.
- **Browse and search:** 200,000+ titles from the IGDB API, with debounced search, infinite scroll, Trending Hits and Upcoming Releases.
- **Authentication:** email sign-up, sign-in and guest mode via Firebase Authentication.

---

## 📊 Results

Evaluated on **200 labelled samples** from a 5-participant pilot study over two weeks.

| Metric | Score |
|---|---|
| Accuracy | **84%** |
| Precision | **81%** |
| Recall | **93%** |
| F1-Score | **0.87** |

| Performance | Measured | Target |
|---|---|---|
| Match Score inference latency | **120 ms** | < 300 ms |
| Database sync (Firestore listener) | **85 ms** | < 300 ms |
| Browse feed initial load | **1.8 s** (< 0.8 s cached) | < 3 s |

- 4 out of 5 participants found the recommendations genuinely relevant.
- 5 out of 5 said the Match Score explanations increased their trust in the system.
- 80% rated the playtime feature as the most useful part of the interface.

<p align="center">
  <img src="images/confusion-matrix.png" width="45%" alt="Confusion matrix">
  <img src="images/latency.png" width="45%" alt="Latency benchmarks">
</p>

---

## 🏗️ Architecture

A four-tier architecture separates the UI, data, machine learning and external data layers:

![Architecture](images/architecture.png)

1. **Client (React 18):** a user action, such as adding a game to Favorites, is written to Firestore.
2. **Persistence (Firebase Firestore):** a real-time listener detects the change and rebuilds the Gamer DNA vector.
3. **Application logic (Python Flask API):** the SVM-RBF model scores candidate games, and Platt scaling turns the scores into probabilities.
4. **External data (IGDB API):** supplies game metadata such as genres, themes, perspectives, developers and Time-to-Beat.

---

## 🧠 How the Model Works

1. **Feature engineering:** genres, themes and player perspectives are one-hot encoded and numerical attributes are scaled.
2. **Behavioural weighting:** library actions set the signal strength (Favorites carry the most), and logged playtime multiplies the weight of a game's attributes.
3. **Classification:** an SVM with an RBF kernel learns the non-linear boundary between games you'd enjoy and games you wouldn't.
4. **Calibration:** Platt scaling converts the SVM decision distance into a percentage Match Score.
5. **Explanation:** the DNA Blade shows the top-weighted attributes behind each score.

**Why an SVM?** It handles high-dimensional one-hot features well, stays robust with small per-user datasets, and supports probability calibration for explainable scores. Random Forest, KNN and Logistic Regression were evaluated and rejected.

---

## 🛠️ Tech Stack

| Layer | Technologies |
|---|---|
| Frontend | React 18, Context API, Framer Motion |
| Backend | Python, Flask (REST API) |
| Machine learning | scikit-learn (SVM-RBF, Platt scaling) |
| Database and auth | Firebase Firestore, Firebase Authentication |
| Data source | IGDB API (Twitch OAuth) |
| Process | Agile sprints, Design Science Research |

---

## 📸 Screenshots

| Browse Feed | Game Detail and Match Score |
|---|---|
| ![Browse](images/browse-feed.png) | ![Detail](images/game-detail.png) |

| Personal Library | Login |
|---|---|
| ![Library](images/library.png) | ![Login](images/login.png) |

---

## 🔮 Future Work

- Hybrid model adding collaborative filtering once there are enough users
- Onboarding flow to reduce cold-start for new users
- Using Time-to-Beat as a filter (for example, "games I can finish this weekend")
- Larger-scale evaluation beyond the pilot cohort

---

## 🚀 Getting Started

### Prerequisites
- Python 3.10+ and Node.js 18+
- A [Twitch developer app](https://dev.twitch.tv/console) for IGDB API access
- A [Firebase](https://console.firebase.google.com) project with Authentication and Firestore enabled

### 1. Backend (Flask)
```bash
cd Backend
python -m venv venv
venv\Scripts\activate          # Windows  (macOS/Linux: source venv/bin/activate)
pip install -r requirements.txt
```
- Copy `.env.example` to `.env` and add your Twitch Client ID and Secret.
- In Firebase Console → Project Settings → Service Accounts, generate a private key and save it as `Backend/serviceAccountKey.json`.

```bash
python app.py                    # runs on http://127.0.0.1:5000
```

### 2. Frontend (React + Vite)
```bash
cd frontend
npm install
npm run dev                      # opens on http://localhost:5173
```
To use your own Firebase project, replace the config in `frontend/src/firebase.js`.

> 🔐 `.env` and `serviceAccountKey.json` are git-ignored and must never be committed.

---

## 📁 Project Structure

```
├── Backend/
│   ├── app.py              # Flask API: IGDB integration, SVM training and Match Score inference
│   ├── requirements.txt
│   └── .env.example
├── frontend/
│   └── src/
│       ├── App.jsx           # Main app: Browse feed, Discovery Hub, authentication
│       ├── DNABlade.jsx      # Gamer DNA radar visualisation
│       ├── GameDetailOverlay.jsx
│       ├── LibraryPage.jsx   # Five-category library and playtime logging
│       ├── firebase.js       # Firebase configuration
│       └── useAuth.js        # Authentication helpers
└── images/                 # Screenshots used in this README
```

---

## 👤 Author

**Mohamed Shanis**
[LinkedIn](https://www.linkedin.com/in/mohamed-shanis) · [GitHub](https://github.com/notmg7) · mohamedshanis006@gmail.com

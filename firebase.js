
const admin = require('firebase-admin');

let db;

function initializeFirebase() {
    try {
        // Create Firebase config from individual environment variables
        const firebaseConfig = {
            type: "service_account",
            project_id: process.env.GOOGLE_PROJECT_ID,
            private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
            client_email: process.env.GOOGLE_CLIENT_EMAIL
        };
        
        // Check if all required config is present
        if (!firebaseConfig.project_id || !firebaseConfig.private_key || !firebaseConfig.client_email) {
            throw new Error('Missing required Firebase environment variables: GOOGLE_PROJECT_ID, GOOGLE_PRIVATE_KEY, GOOGLE_CLIENT_EMAIL');
        }
        
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(firebaseConfig),
                databaseURL: process.env.FIREBASE_DB_URL
            });
        }
        
        db = admin.database();
        console.log('✅ Firebase Realtime Database initialized successfully');
        
    } catch (error) {
        console.error('❌ Firebase initialization error:', error);
        console.log('ℹ️ Please set the following environment variables: GOOGLE_PROJECT_ID, GOOGLE_PRIVATE_KEY, GOOGLE_CLIENT_EMAIL, FIREBASE_DB_URL');
    }
}

async function saveToFirebase(collection, docId, data) {
    try {
        if (!db) throw new Error('Firebase not initialized');
        await db.ref(`${collection}/${docId}`).set(data);
        return true;
    } catch (error) {
        console.error('❌ Firebase save error:', error);
        return false;
    }
}

async function getFromFirebase(collection, docId) {
    try {
        if (!db) throw new Error('Firebase not initialized');
        const snapshot = await db.ref(`${collection}/${docId}`).get();
        return snapshot.exists() ? snapshot.val() : null;
    } catch (error) {
        console.error('❌ Firebase get error:', error);
        return null;
    }
}

async function deleteFromFirebase(collection, docId) {
    try {
        if (!db) throw new Error('Firebase not initialized');
        await db.ref(`${collection}/${docId}`).remove();
        return true;
    } catch (error) {
        console.error('❌ Firebase delete error:', error);
        return false;
    }
}

async function queryFirebase(collection, field, operator, value) {
    try {
        if (!db) throw new Error('Firebase not initialized');
        let query = db.ref(collection);
        
        // Handle different query operators for Realtime Database
        switch (operator) {
            case '==':
                query = query.orderByChild(field).equalTo(value);
                break;
            case '>':
                query = query.orderByChild(field).startAt(value);
                break;
            case '<':
                query = query.orderByChild(field).endAt(value);
                break;
            default:
                query = query.orderByChild(field).equalTo(value);
        }
        
        const snapshot = await query.get();
        const results = [];
        
        snapshot.forEach(childSnapshot => {
            results.push({ 
                id: childSnapshot.key, 
                ...childSnapshot.val() 
            });
        });
        
        return results;
    } catch (error) {
        console.error('❌ Firebase query error:', error);
        return [];
    }
}

module.exports = {
    initializeFirebase,
    saveToFirebase,
    getFromFirebase,
    deleteFromFirebase,
    queryFirebase
};

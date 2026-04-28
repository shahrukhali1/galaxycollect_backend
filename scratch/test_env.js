import dotenv from 'dotenv';
dotenv.config();
console.log('MONGO_URI:', process.env.MONGO_URI ? 'Configured' : 'NOT Configured');
console.log('URI Value:', process.env.MONGO_URI);

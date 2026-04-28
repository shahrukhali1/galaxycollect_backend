import mongoose from 'mongoose';

const CategorySchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  image: { type: String },
  isPopular: { type: Boolean, default: false },
  status: { type: String, default: 'Active' }
}, {
  timestamps: true
});

const Category = mongoose.models.Category || mongoose.model('Category', CategorySchema);
export default Category;

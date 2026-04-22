import mongoose from 'mongoose';

const BlogSchema = new mongoose.Schema({
  title: { type: String, required: true },
  imageURL: { type: String, required: true },
  description: { type: String, required: true },
  category: { type: String, required: true }
}, {
  timestamps: true
});

BlogSchema.index({ createdAt: -1 });

const Blog = mongoose.models.Blog || mongoose.model('Blog', BlogSchema);
export default Blog;

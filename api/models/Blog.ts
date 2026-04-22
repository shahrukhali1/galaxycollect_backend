import mongoose from 'mongoose';

const BlogSchema = new mongoose.Schema({
  title: { type: String, required: true },
  imageURL: { type: String, required: true },
  description: { type: String, required: true },
  category: { type: String, required: true },
}, {
  timestamps: true
});

BlogSchema.index({ createdAt: -1 });

export interface IBlog extends mongoose.Document {
  title: string;
  imageURL: string;
  description: string;
  category: string;
  createdAt: Date;
}

const Blog = mongoose.models.Blog || mongoose.model<IBlog>('Blog', BlogSchema);
export default Blog;

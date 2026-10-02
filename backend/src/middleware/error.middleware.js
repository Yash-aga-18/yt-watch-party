// middleware/error.middleware.js

const errorHandler = (err, req, res, next) => {
  console.error(err);

  res.status(500).json({
    error: "Server error"
  });
};

export default errorHandler;
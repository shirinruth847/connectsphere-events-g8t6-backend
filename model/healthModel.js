const healthCheck = async () => {
    try {
        return "App is working well";
    } catch (error) {
        return error;
    }
};

module.exports = healthCheck;

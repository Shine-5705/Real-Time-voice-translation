import logging

def get_logger(name: str) -> logging.Logger:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s.%(msecs)03d | %(levelname)s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S.%f[:06]",
    )
    logger = logging.getLogger(name)
    logger.setLevel(logging.INFO)
    return logger